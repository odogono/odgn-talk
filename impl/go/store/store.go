// Package store supplies the in-memory Host implementation of the store
// Standard Capability (chapter 7, ADR 0050 and ADR 0062).
package store

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"sync"

	talk "github.com/odogono/odgn-talk/impl/go"
	"github.com/odogono/odgn-talk/impl/go/internal/machine"
	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
)

// Quotas counts each Store's committed contents and live Segments' net growth
// by logical size, including keys. Zero is a real limit.
type Quotas struct{ Size, Keys, Value int64 }

// SessionQuotas returns chapter 12's fixed Session Store limits.
func SessionQuotas() Quotas { return Quotas{Size: 1048576, Keys: 1000, Value: 65536} }

type identity struct {
	group   *talk.Group
	segment string
}
type pending struct {
	replacement *talk.Value
	deltas      []talk.Value
}

// segment holds a live Segment's pending writes, by Store name and key.
type segment map[string]map[string]pending

// Stores holds named Stores, initially empty. Its methods serialize access
// across Groups; callers must use lifecycle hooks around Segment writes. It
// is the Segment Coordinator of every Store it holds, so one Segment's
// writes to several Stores commit together (ADR 0069).
type Stores struct {
	mu       sync.Mutex
	quotas   Quotas
	contents map[string]map[string]talk.Value
	segments map[identity]segment
	order    []identity // live Segments in begin order, for sequential rounding
}

var _ talk.StoreImpl = (*Stores)(nil)

func New(quotas Quotas) *Stores {
	return &Stores{quotas: quotas, contents: map[string]map[string]talk.Value{}, segments: map[identity]segment{}}
}
func storeName(binding any) (string, error) {
	name, ok := binding.(string)
	if !ok {
		return "", &talk.HostError{Code: talk.InvalidValue, Detail: "A Store’s binding is its name, as text"}
	}
	return name, nil
}
func at(c *talk.Call) identity                 { return identity{c.Group(), c.SegmentID()} }
func contextAt(c talk.SegmentContext) identity { return identity{c.Group, c.SegmentID} }
func (s *Stores) committed(name string) map[string]talk.Value {
	entries := s.contents[name]
	if entries == nil {
		entries = map[string]talk.Value{}
		s.contents[name] = entries
	}
	return entries
}
func (s *Stores) forget(id identity) {
	delete(s.segments, id)
	s.order = slices.DeleteFunc(s.order, func(other identity) bool { return id == other })
}

// Begin starts the Segment with its first enrolled Store. Every Store it
// writes later, through any Grant, joins it with no hook.
func (s *Stores) Begin(c talk.SegmentContext) talk.EffectResult {
	s.mu.Lock()
	defer s.mu.Unlock()
	name, err := storeName(c.Binding)
	if err != nil {
		return talk.EffectResult{Status: talk.EffectFailed, Detail: err.Error()}
	}
	id := contextAt(c)
	if s.segments[id] != nil {
		return talk.EffectResult{Status: talk.EffectFailed, Detail: "A Store Segment has already begun"}
	}
	s.committed(name)
	s.segments[id] = segment{name: {}}
	s.order = append(s.order, id)
	return talk.EffectResult{Status: talk.EffectOK}
}
func (s *Stores) Commit(c talk.SegmentContext) talk.EffectResult {
	s.mu.Lock()
	defer s.mu.Unlock()
	id := contextAt(c)
	seg := s.segments[id]
	s.forget(id)
	if seg == nil {
		return talk.EffectResult{Status: talk.EffectOK}
	}
	changes := map[string]map[string]talk.Value{}
	for name, keys := range seg {
		entries := s.committed(name)
		changes[name] = map[string]talk.Value{}
		for key, p := range keys {
			v, err := applied(entries[key], p)
			if err != nil {
				return talk.EffectResult{Status: talk.EffectFailed, Detail: err.Error()}
			}
			changes[name][key] = v
		}
	}
	// No Store changes until every value of every Store has been computed.
	for name, values := range changes {
		entries := s.committed(name)
		for key, v := range values {
			if v.Kind() == talk.KindNothing {
				delete(entries, key)
			} else {
				entries[key] = v
			}
		}
	}
	return talk.EffectResult{Status: talk.EffectOK}
}
func (s *Stores) Rollback(c talk.SegmentContext) talk.EffectResult {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.forget(contextAt(c))
	return talk.EffectResult{Status: talk.EffectOK}
}

// own gives the calling Segment's pending writes to the Store, or nil.
func (s *Stores) own(c *talk.Call, name string) map[string]pending {
	return s.segments[at(c)][name]
}

// writes gives the calling Segment's pending writes to the Store, adding the
// Store to the Segment at its first write, or nil outside a Segment.
func (s *Stores) writes(c *talk.Call, name string) map[string]pending {
	seg := s.segments[at(c)]
	if seg == nil {
		return nil
	}
	if seg[name] == nil {
		s.committed(name)
		seg[name] = map[string]pending{}
	}
	return seg[name]
}
func applied(base talk.Value, p pending) (talk.Value, error) {
	if p.replacement != nil {
		base = *p.replacement
	}
	for _, delta := range p.deltas {
		if base.Kind() == talk.KindNothing {
			base = delta
		} else {
			v, err := talk.Add(base, delta)
			if err != nil {
				return talk.Nothing, err
			}
			base = v
		}
	}
	return base, nil
}
func (s *Stores) seen(c *talk.Call, name, key string) (talk.Value, error) {
	base := s.committed(name)[key]
	if own := s.own(c, name); own != nil {
		return applied(base, own[key])
	}
	return base, nil
}
func failure(code string, pairs ...talk.Pair) *talk.ScriptError {
	data, _ := talk.Map(pairs...)
	// Use the Core catalogue, including its message, as Add does.
	fields := make([]corevalue.Pair, len(pairs))
	for i, p := range pairs {
		b, _ := talk.EncodeValue(p.Val)
		v, _ := corevalue.Decode(b, true, nil)
		fields[i] = corevalue.Pair{Key: p.Key, Val: v}
	}
	e := machine.ErrorValue(code, fields...)
	return &talk.ScriptError{Code: code, Message: e.Get("message").Text(), Data: data}
}
func text(s string) talk.Value { v, _ := talk.Text(s); return v }
func size(v talk.Value) int64 {
	// Logical size ignores Object identity; storable Values never hold Objects.
	b, err := talk.EncodeValue(v)
	if err != nil {
		panic(err) // size is used only after validating a storable data Value.
	}
	inner, err := corevalue.Decode(b, true, nil)
	if err != nil {
		panic(err) // size is used only after validating a storable data Value.
	}
	return machine.Size(inner)
}
func entrySize(key string, v talk.Value) int64 { return size(text(key)) + size(v) }
func objectKind(v talk.Value) (string, bool) {
	switch v.Kind() {
	case talk.KindObject:
		encoded, _ := talk.EncodeValue(v)
		var object struct {
			Ref []string `json:"$object"`
		}
		if err := json.Unmarshal(encoded, &object); err != nil || len(object.Ref) != 2 {
			panic("invalid Host Object encoding")
		}
		return object.Ref[0], true
	case talk.KindList:
		for i := 1; i <= v.Len(); i++ {
			if k, ok := objectKind(v.Index(i)); ok {
				return k, true
			}
		}
	case talk.KindMap:
		for _, p := range v.Entries() {
			if k, ok := objectKind(p.Val); ok {
				return k, true
			}
		}
	case talk.KindRange:
		a, b, _ := v.AsRange()
		if k, ok := objectKind(a); ok {
			return k, true
		}
		return objectKind(b)
	}
	return "", false
}
func storable(v talk.Value) error {
	if kind, ok := objectKind(v); ok {
		return failure("can't store", talk.KV("kind", text(kind)))
	}
	_, err := talk.EncodeValue(v)
	return err
}
func (s *Stores) unreserved(c *talk.Call, name, key string, replacing bool) error {
	for id, seg := range s.segments {
		p, found := seg[name][key]
		if id != at(c) && found && (replacing || p.replacement != nil) {
			return failure("store busy", talk.KV("key", text(key)))
		}
	}
	return nil
}
func (s *Stores) grows(c *talk.Call, name, key string, next pending, written talk.Value) error {
	if written.Kind() != talk.KindNothing && size(written) > s.quotas.Value {
		return failure("store full", talk.KV("limit", text("value")))
	}
	committed := s.committed(name)
	keys, total := int64(len(committed)), int64(0)
	for k, v := range committed {
		total += entrySize(k, v)
	}
	mine := map[string]pending{}
	for k, p := range s.own(c, name) {
		mine[k] = p
	}
	mine[key] = next
	changes := []map[string]pending{mine}
	for id, seg := range s.segments {
		if id != at(c) && seg[name] != nil {
			changes = append(changes, seg[name])
		}
	}
	for _, writes := range changes {
		grownKeys, grownSize := int64(0), int64(0)
		for k, p := range writes {
			old := committed[k]
			base := old
			if p.replacement != nil {
				base = *p.replacement
			}
			if base.Kind() == talk.KindNothing && len(p.deltas) > 0 {
				base = p.deltas[0]
			}
			if old.Kind() != talk.KindNothing {
				grownKeys--
				grownSize -= entrySize(k, old)
			}
			if base.Kind() != talk.KindNothing {
				grownKeys++
				grownSize += entrySize(k, base)
			}
		}
		keys += max(0, grownKeys)
		total += max(0, grownSize)
	}
	if keys > s.quotas.Keys {
		return failure("store full", talk.KV("limit", text("keys")))
	}
	if total > s.quotas.Size {
		return failure("store full", talk.KV("limit", text("size")))
	}
	return nil
}
func (s *Stores) write(c *talk.Call, name, key string, v talk.Value) error {
	seg := s.writes(c, name)
	if seg == nil {
		return fmt.Errorf("A Store write outside its Segment")
	}
	if err := s.unreserved(c, name, key, true); err != nil {
		return err
	}
	next := pending{replacement: &v}
	if err := s.grows(c, name, key, next, v); err != nil {
		return err
	}
	seg[key] = next
	return nil
}
func (s *Stores) Get(c *talk.Call, key string, fallback talk.Value) (talk.Value, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	name, err := storeName(c.Binding())
	if err != nil {
		return talk.Nothing, err
	}
	v, err := s.seen(c, name, key)
	if v.Kind() == talk.KindNothing && err == nil {
		v = fallback
	}
	return v, err
}
func (s *Stores) Set(c *talk.Call, key string, v talk.Value) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	name, err := storeName(c.Binding())
	if err != nil {
		return err
	}
	if err := storable(v); err != nil {
		return err
	}
	return s.write(c, name, key, v)
}
func (s *Stores) Delete(c *talk.Call, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	name, err := storeName(c.Binding())
	if err != nil {
		return err
	}
	return s.write(c, name, key, talk.Nothing)
}
func (s *Stores) Keys(c *talk.Call, prefix string) (talk.Value, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	name, err := storeName(c.Binding())
	if err != nil {
		return talk.Nothing, err
	}
	keys := map[string]bool{}
	for key := range s.committed(name) {
		keys[key] = true
	}
	for key := range s.own(c, name) {
		keys[key] = true
	}
	var names []string
	for key := range keys {
		if !strings.HasPrefix(key, prefix) {
			continue
		}
		v, err := s.seen(c, name, key)
		if err != nil {
			return talk.Nothing, err
		}
		if v.Kind() != talk.KindNothing {
			names = append(names, key)
		}
	}
	slices.Sort(names) // UTF-8 byte order preserves Unicode scalar order.
	values := make([]talk.Value, len(names))
	for i, name := range names {
		values[i] = text(name)
	}
	return talk.List(values...), nil
}
func (s *Stores) Swap(c *talk.Call, key string, expected, replacement talk.Value) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	name, err := storeName(c.Binding())
	if err != nil {
		return false, err
	}
	if err := storable(replacement); err != nil {
		return false, err
	}
	if err := s.unreserved(c, name, key, true); err != nil {
		return false, err
	}
	seen, err := s.seen(c, name, key)
	if err != nil {
		return false, err
	}
	if !seen.Equal(expected) {
		return false, nil
	}
	if err := s.write(c, name, key, replacement); err != nil {
		return false, err
	}
	return true, nil
}
func (s *Stores) Increment(c *talk.Call, key string, by talk.Value) (talk.Value, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	name, err := storeName(c.Binding())
	if err != nil {
		return talk.Nothing, err
	}
	seg := s.writes(c, name)
	if seg == nil {
		return talk.Nothing, fmt.Errorf("A Store write outside its Segment")
	}
	if by.Kind() == talk.KindNothing {
		by = talk.Int(1)
	}
	if err := s.unreserved(c, name, key, false); err != nil {
		return talk.Nothing, err
	}
	seen, err := s.seen(c, name, key)
	if err != nil {
		return talk.Nothing, err
	}
	if seen.Kind() != talk.KindNothing && seen.Kind() != talk.KindNumber && seen.Kind() != talk.KindQuantity {
		return talk.Nothing, failure("wrong kind", talk.KV("expected", text("number")), talk.KV("got", text(corevalue.KindNames[corevalue.Kind(seen.Kind())])), talk.KV("value", seen))
	}
	result, err := applied(seen, pending{deltas: []talk.Value{by}})
	if err != nil {
		return talk.Nothing, err
	}
	own := seg[key]
	next := pending{replacement: own.replacement, deltas: append(slices.Clone(own.deltas), by)}
	if own.replacement == nil {
		projected := s.committed(name)[key]
		for _, id := range s.order {
			if other := s.segments[id][name]; id != at(c) && other != nil {
				projected, err = applied(projected, pending{deltas: other[key].deltas})
				if err != nil {
					return talk.Nothing, err
				}
			}
		}
		if _, err := applied(projected, pending{deltas: next.deltas}); err != nil {
			return talk.Nothing, err
		}
	}
	written := talk.Nothing
	if seen.Kind() == talk.KindNothing {
		written = by
	}
	if err := s.grows(c, name, key, next, written); err != nil {
		return talk.Nothing, err
	}
	seg[key] = next
	return result, nil
}

// Entries returns committed contents in Unicode code-point order.
func (s *Stores) Entries(name string) []talk.Pair {
	s.mu.Lock()
	defer s.mu.Unlock()
	entries := s.committed(name)
	keys := make([]string, 0, len(entries))
	for key := range entries {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	out := make([]talk.Pair, len(keys))
	for i, key := range keys {
		out[i] = talk.KV(key, entries[key])
	}
	return out
}

// Replace atomically replaces committed contents between Pumps, refusing live
// writers, duplicate/empty keys, non-data values and exceeded quotas.
func (s *Stores) Replace(name string, entries []talk.Pair) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, seg := range s.segments {
		if seg[name] != nil {
			return fmt.Errorf("A Segment is writing to the Store")
		}
	}
	next := map[string]talk.Value{}
	seen := map[string]bool{}
	total := int64(0)
	for _, p := range entries {
		key, err := talk.Text(p.Key)
		if err != nil {
			return err
		}
		k, _ := key.AsText()
		if k == "" || seen[k] {
			return fmt.Errorf("Store keys must be distinct, nonempty text")
		}
		seen[k] = true
		if err := storable(p.Val); err != nil {
			return err
		}
		if size(p.Val) > s.quotas.Value {
			return fmt.Errorf("A value is past the Store’s value limit")
		}
		if p.Val.Kind() != talk.KindNothing {
			next[k] = p.Val
			total += entrySize(k, p.Val)
		}
	}
	if int64(len(next)) > s.quotas.Keys || total > s.quotas.Size {
		return fmt.Errorf("The contents are past the Store’s quotas")
	}
	s.contents[name] = next
	return nil
}
func (s *Stores) Clear(name string) error { return s.Replace(name, nil) }
