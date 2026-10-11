// Package notify is the notification router (Store Notifications, The
// router; ADR 0061). It holds Scripts' watches on Stores, routes each
// commit's changed keys to them as ordinary Deliveries, holds what a full
// mailbox refuses within the Store's limits, and retries after each Pump. It
// is built only on the embedding interface: Calls and release contexts name a
// watch's owner, and Script.Deliver, Group.ScriptNames, Group.Save and
// Core.Restore are all it calls.
//
// Concurrency: each Store has a synchronization, a mutex that Watch, Unwatch,
// Commit, marker admission, retry, Save and Restore take, and the router's
// own state has one more, always taken after the Stores'. Deliveries are made
// while both are held. Script.Deliver only queues, and the Core never holds a
// Group's lock while it runs Host code, so a Delivery can't deadlock; but a
// Group's OnReady callback, which Deliver calls, must not call back into the
// router synchronously.
package notify

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"slices"
	"sort"
	"strings"
	"sync"

	talk "github.com/odogono/odgn-talk/impl/go"
	"github.com/odogono/odgn-talk/impl/go/internal/machine"
	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
)

// WatchLimits are a Store's four limits on its watches (Store Notifications,
// Limits).
type WatchLimits struct {
	// Watches is the most watches, across every Script and Group.
	Watches int64
	// WatchSize is the most their names, prefixes and effective messages may
	// total, by logical size.
	WatchSize int64
	// Pending is the most pending Notifications, with one marker reserved per
	// watch.
	Pending int64
	// PendingSize is the most their payloads may total, with every marker
	// reserved.
	PendingSize int64
}

// RouterOptions are the Host's per-Store limits and revisions.
type RouterOptions struct {
	Limits func(store string) WatchLimits
	// Revision is the Store's current revision; the router reads it under the
	// Store's synchronization.
	Revision func(store string) string
}

// RoutingResult lists a restore's watches, each "<script>.<grant>.<watch>",
// in the order of watches.
type RoutingResult struct {
	Restored, Dropped, Resynced []string
}

// Changed reports whether a commit changed a key's value: compared by the
// bytes of the Value Encoding, with a missing key, given as Nothing, and
// Nothing one state (Net changes).
func Changed(before, after talk.Value) bool {
	a, b := before.Kind() == talk.KindNothing, after.Kind() == talk.KindNothing
	if a || b {
		return a != b
	}
	x, err := talk.EncodeValue(before)
	if err != nil {
		return true
	}
	y, err := talk.EncodeValue(after)
	if err != nil {
		return true
	}
	return string(x) != string(y)
}

// outcome is what a Group did with one Delivery.
type outcome int

const (
	admitted outcome = iota
	full             // refused with MailboxFull: held
	refused          // refused for any other reason: the watch is removed
)

// target is a Group as the router uses it. A *talk.Group is one through
// groupTarget; the kit uses stand-ins.
type target interface {
	scriptNames() []string
	deliver(script, message string, payload talk.Value) outcome
	save() ([]byte, error)
}

// groupTarget is comparable, so equal Groups are one map key.
type groupTarget struct{ g *talk.Group }

func (t groupTarget) scriptNames() []string { return t.g.ScriptNames() }
func (t groupTarget) save() ([]byte, error) { return t.g.Save() }
func (t groupTarget) deliver(script, message string, payload talk.Value) outcome {
	s := t.g.Script(script)
	if s == nil {
		return refused
	}
	_, err := s.Deliver(talk.Message{Name: message, Args: []talk.Value{payload}})
	switch {
	case err == nil:
		return admitted
	case errors.Is(err, talk.ErrMailboxFull):
		return full
	}
	return refused
}

// held is a pending ordinary Notification: its changed keys and its
// payload's logical size.
type held struct {
	keys []string
	size int64
}

type watch struct {
	group                      target
	script, grant, name, store string
	prefix, message            string
	held                       []held // oldest first; empty while resyncing
	heldSize                   int64
	resyncing                  bool
}

// position is where a retry round starts: after this watch.
type position struct {
	Script string `json:"script"`
	Grant  string `json:"grant"`
	Name   string `json:"name"`
}

type groupState struct {
	rank    int64 // its place among Groups, from when it last came to hold a watch
	watches map[*watch]bool
	retry   *position
}

// Router holds watches and routes commits. Make one with New.
type Router struct {
	o RouterOptions

	locksMu sync.Mutex
	locks   map[string]*sync.Mutex // each Store's synchronization

	mu     sync.Mutex // the router's state; taken after any Store's
	groups map[target]*groupState
	stores map[string]map[*watch]bool
	ranks  int64
}

// New makes a router with no watches.
func New(o RouterOptions) *Router {
	return &Router{o: o, locks: map[string]*sync.Mutex{}, groups: map[target]*groupState{}, stores: map[string]map[*watch]bool{}}
}

func (r *Router) storeLock(store string) *sync.Mutex {
	r.locksMu.Lock()
	defer r.locksMu.Unlock()
	l := r.locks[store]
	if l == nil {
		l = &sync.Mutex{}
		r.locks[store] = l
	}
	return l
}

// lock takes the named Stores' synchronizations, in code-point order, then
// the router's lock; the returned function releases them.
func (r *Router) lock(stores ...string) func() {
	stores = slices.Clone(stores)
	slices.Sort(stores)
	stores = slices.Compact(stores)
	locks := make([]*sync.Mutex, len(stores))
	for i, s := range stores {
		locks[i] = r.storeLock(s)
		locks[i].Lock()
	}
	r.mu.Lock()
	return func() {
		r.mu.Unlock()
		for i := len(locks) - 1; i >= 0; i-- {
			locks[i].Unlock()
		}
	}
}

// lockGroup takes the synchronization of every Store the Group's watches
// are on, and of extra, then the router's lock. A watch on another Store
// may be registered while it waits, so it checks and tries again.
func (r *Router) lockGroup(t target, extra ...string) func() {
	storesOf := func() []string {
		out := slices.Clone(extra)
		if state := r.groups[t]; state != nil {
			for w := range state.watches {
				out = append(out, w.store)
			}
		}
		return out
	}
	r.mu.Lock()
	want := storesOf()
	r.mu.Unlock()
	for {
		unlock := r.lock(want...)
		now := storesOf()
		if !slices.ContainsFunc(now, func(s string) bool { return !slices.Contains(want, s) }) {
			return unlock
		}
		unlock()
		want = now
	}
}

func text(s string) talk.Value { v, _ := talk.Text(s); return v }

// sizeOf is a data Value's logical size (chapter 8).
func sizeOf(v talk.Value) int64 {
	b, err := talk.EncodeValue(v)
	if err != nil {
		panic(err) // payloads and texts are always encodable data
	}
	inner, err := corevalue.Decode(b, true, nil)
	if err != nil {
		panic(err)
	}
	return machine.Size(inner)
}

func payloadOf(grant, name, prefix string, keys []string, resync bool) talk.Value {
	items := make([]talk.Value, len(keys))
	for i, k := range keys {
		items[i] = text(k)
	}
	v, _ := talk.Map(
		talk.KV("grant", text(grant)),
		talk.KV("watch", text(name)),
		talk.KV("prefix", text(prefix)),
		talk.KV("keys", talk.List(items...)),
		talk.KV("resync", talk.Bool(resync)),
	)
	return v
}

func watchSize(name, prefix, message string) int64 {
	return sizeOf(text(name)) + sizeOf(text(prefix)) + sizeOf(text(message))
}
func markerSize(grant, name, prefix string) int64 {
	return sizeOf(payloadOf(grant, name, prefix, nil, true))
}
func (w *watch) payload(keys []string, resync bool) talk.Value {
	return payloadOf(w.grant, w.name, w.prefix, keys, resync)
}
func (w *watch) label() string { return w.script + "." + w.grant + "." + w.name }
func (w *watch) hasWork() bool { return w.resyncing || len(w.held) > 0 }
func (w *watch) discardWork()  { w.held, w.heldSize = nil, 0 }
func (w *watch) owned(t target, script, grant string) bool {
	return w.group == t && w.script == script && w.grant == grant
}

// watchLimit is the ScriptError `watch limit` {limit}.
func watchLimit(limit string) *talk.ScriptError {
	data, _ := talk.Map(talk.KV("limit", text(limit)))
	word, _ := corevalue.NewText(limit)
	field := corevalue.Pair{Key: "limit", Val: word}
	message := machine.ErrorValue("watch limit", field).Get("message").Text()
	if message == "watch limit" {
		// Until the catalogue holds it, the Spec's template.
		message = strings.ReplaceAll("The Store's {limit} limit for watches would be exceeded", "{limit}", field.Val.Display())
	}
	return &talk.ScriptError{Code: "watch limit", Message: message, Data: data}
}

func storeOf(binding any) (string, error) {
	name, ok := binding.(string)
	if !ok {
		return "", &talk.HostError{Code: talk.InvalidValue, Detail: "A Store’s binding is its name, as text"}
	}
	return name, nil
}

// Called with r.mu held.
func (r *Router) find(t target, script, grant, name string) *watch {
	if state := r.groups[t]; state != nil {
		for w := range state.watches {
			if w.owned(t, script, grant) && w.name == name {
				return w
			}
		}
	}
	return nil
}

// index is a Script's place in names, or len(names) if it has none.
func index(names []string, script string) int {
	if i := slices.Index(names, script); i >= 0 {
		return i
	}
	return len(names)
}

// order sorts watches into the order of watches: by Group rank, then Script
// load order, Grant and name by code points.
func (r *Router) order(watches []*watch) []*watch {
	out := slices.Clone(watches)
	loads := map[target][]string{}
	load := func(t target) []string {
		names, ok := loads[t]
		if !ok {
			names = t.scriptNames()
			loads[t] = names
		}
		return names
	}
	slices.SortStableFunc(out, func(a, b *watch) int {
		if ra, rb := r.groups[a.group].rank, r.groups[b.group].rank; ra != rb {
			return cmpInt(ra, rb)
		}
		if c := cmpInt(int64(index(load(a.group), a.script)), int64(index(load(b.group), b.script))); c != 0 {
			return c
		}
		if c := strings.Compare(a.grant, b.grant); c != 0 {
			return c
		}
		return strings.Compare(a.name, b.name)
	})
	return out
}

func cmpInt(a, b int64) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}

// after reports whether w is after p within one Group.
func after(names []string, w *watch, p position) bool {
	if c := index(names, w.script) - index(names, p.Script); c != 0 {
		return c > 0
	}
	if c := strings.Compare(w.grant, p.Grant); c != 0 {
		return c > 0
	}
	return strings.Compare(w.name, p.Name) > 0
}

func keysOf[K comparable](m map[K]bool) []K {
	out := make([]K, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func (r *Router) add(w *watch) {
	state := r.groups[w.group]
	if state == nil {
		state = &groupState{rank: r.ranks, watches: map[*watch]bool{}}
		r.ranks++
		r.groups[w.group] = state
	}
	state.watches[w] = true
	if r.stores[w.store] == nil {
		r.stores[w.store] = map[*watch]bool{}
	}
	r.stores[w.store][w] = true
}

// remove forgets a watch; a Group holding none gives up its place and its
// retry position.
func (r *Router) remove(w *watch) {
	if state := r.groups[w.group]; state != nil && state.watches[w] {
		delete(state.watches, w)
		if len(state.watches) == 0 {
			delete(r.groups, w.group)
		}
	}
	delete(r.stores[w.store], w)
	if len(r.stores[w.store]) == 0 {
		delete(r.stores, w.store)
	}
}

type totals struct{ watches, size, pending, pendingSize int64 }

func (r *Router) totals(store string, without *watch) totals {
	var t totals
	for w := range r.stores[store] {
		if w == without {
			continue
		}
		t.watches++
		t.size += watchSize(w.name, w.prefix, w.message)
		t.pending += 1 + int64(len(w.held))
		t.pendingSize += markerSize(w.grant, w.name, w.prefix) + w.heldSize
	}
	return t
}

// hold keeps an ordinary Notification, or makes the watch resyncing if that
// would pass a pending limit.
func (r *Router) hold(w *watch, keys []string, payload talk.Value) {
	size := sizeOf(payload)
	limits := r.o.Limits(w.store)
	now := r.totals(w.store, nil)
	if now.pending+1 > limits.Pending || now.pendingSize+size > limits.PendingSize {
		w.discardWork()
		w.resyncing = true
		return
	}
	w.held = append(w.held, held{keys, size})
	w.heldSize += size
}

// drain delivers a watch's pending work, oldest first, until a refusal.
func (r *Router) drain(w *watch) {
	for w.hasWork() {
		var keys []string
		if !w.resyncing {
			keys = w.held[0].keys
		}
		switch w.group.deliver(w.script, w.message, w.payload(keys, w.resyncing)) {
		case full:
			return
		case refused:
			r.remove(w)
			return
		}
		if w.resyncing {
			w.resyncing = false
		} else {
			w.heldSize -= w.held[0].size
			w.held = w.held[1:]
		}
	}
}

// Watch registers or replaces the calling Script's watch through the Call's
// Grant. It fails with the ScriptError `watch limit` {limit}.
func (r *Router) Watch(c *talk.Call, name, prefix, message string) error {
	store, err := storeOf(c.Binding())
	if err != nil {
		return err
	}
	return r.watch(groupTarget{c.Group()}, c.ScriptName(), c.GrantName(), store, name, prefix, message)
}

func (r *Router) watch(t target, script, grant, store, name, prefix, message string) error {
	defer r.lock(store)()
	existing := r.find(t, script, grant, name)
	if existing != nil && existing.prefix == prefix && existing.message == message {
		return nil
	}
	limits := r.o.Limits(store)
	now := r.totals(store, existing)
	switch {
	case now.watches+1 > limits.Watches:
		return watchLimit("watches")
	case now.size+watchSize(name, prefix, message) > limits.WatchSize:
		return watchLimit("size")
	case now.pending+1 > limits.Pending || now.pendingSize+markerSize(grant, name, prefix) > limits.PendingSize:
		return watchLimit("pending")
	}
	if existing != nil {
		existing.prefix, existing.message = prefix, message
		existing.discardWork()
		existing.resyncing = false
		return nil
	}
	r.add(&watch{group: t, script: script, grant: grant, store: store, name: name, prefix: prefix, message: message})
	return nil
}

// Unwatch removes the calling Script's watch through the Call's Grant, if
// there is one.
func (r *Router) Unwatch(c *talk.Call, name string) error {
	store, err := storeOf(c.Binding())
	if err != nil {
		return err
	}
	r.unwatch(groupTarget{c.Group()}, c.ScriptName(), c.GrantName(), store, name)
	return nil
}

func (r *Router) unwatch(t target, script, grant, store, name string) {
	defer r.lock(store)()
	if w := r.find(t, script, grant, name); w != nil {
		r.remove(w)
	}
}

// Release removes every watch the context's owner holds, and their pending
// work. It is the release hook's body.
func (r *Router) Release(ctx talk.GrantContext) {
	r.release(groupTarget{ctx.Group}, ctx.ScriptName, ctx.GrantName)
}

func (r *Router) release(t target, script, grant string) {
	defer r.lockGroup(t)()
	if state := r.groups[t]; state != nil {
		for _, w := range keysOf(state.watches) {
			if w.owned(t, script, grant) {
				r.remove(w)
			}
		}
	}
}

// Commit applies a commit under the Store's synchronization and routes its
// changed keys. apply makes the change and returns the changed keys; an
// error means the commit failed, and nothing is routed.
func (r *Router) Commit(store string, apply func() ([]string, error)) error {
	l := r.storeLock(store)
	l.Lock()
	defer l.Unlock()
	changed, err := apply()
	if err != nil {
		return err
	}
	keys := slices.Clone(changed)
	slices.Sort(keys) // UTF-8 byte order is code-point order
	keys = slices.Compact(keys)
	if len(keys) == 0 {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, w := range r.order(keysOf(r.stores[store])) {
		var matched []string
		for _, k := range keys {
			if strings.HasPrefix(k, w.prefix) {
				matched = append(matched, k)
			}
		}
		if len(matched) == 0 || w.resyncing {
			continue
		}
		payload := w.payload(matched, false)
		if len(w.held) > 0 {
			r.hold(w, matched, payload)
			continue
		}
		switch w.group.deliver(w.script, w.message, payload) {
		case full:
			r.hold(w, matched, payload)
		case refused:
			r.remove(w)
		}
	}
	return nil
}

// Pumped retries the Group's pending work; the Host calls it after each Pump
// of the Group returns. It reports whether the Group still has pending work.
func (r *Router) Pumped(g *talk.Group) bool { return r.pumped(groupTarget{g}) }

func (r *Router) pumped(t target) bool {
	defer r.lockGroup(t)()
	state := r.groups[t]
	if state == nil {
		return false
	}
	var waiting []*watch
	for _, w := range r.order(keysOf(state.watches)) {
		if w.hasWork() {
			waiting = append(waiting, w)
		}
	}
	if len(waiting) == 0 {
		return false
	}
	start := 0
	if state.retry != nil {
		names := t.scriptNames()
		if i := slices.IndexFunc(waiting, func(w *watch) bool { return after(names, w, *state.retry) }); i > 0 {
			start = i
		}
	}
	round := append(slices.Clone(waiting[start:]), waiting[:start]...)
	first := round[0]
	state.retry = &position{first.script, first.grant, first.name}
	for _, w := range round {
		r.drain(w)
	}
	if state := r.groups[t]; state != nil {
		for w := range state.watches {
			if w.hasWork() {
				return true
			}
		}
	}
	return false
}

// Detach removes every watch the Group's Scripts hold; the Host calls it when
// it stops using the Group.
func (r *Router) Detach(g *talk.Group) { r.detach(groupTarget{g}) }

func (r *Router) detach(t target) {
	defer r.lockGroup(t)()
	if state := r.groups[t]; state != nil {
		for _, w := range keysOf(state.watches) {
			r.remove(w)
		}
	}
}

// A checkpoint is this header, the routing state as one line of JSON, and
// the Group save's bytes.
const header = "northtalk notify checkpoint go/1\n"

type savedWatch struct {
	Script    string     `json:"script"`
	Grant     string     `json:"grant"`
	Name      string     `json:"name"`
	Store     string     `json:"store"`
	Prefix    string     `json:"prefix"`
	Message   string     `json:"message"`
	Resyncing bool       `json:"resyncing"`
	Held      [][]string `json:"held"`
}
type routingState struct {
	Digest    string            `json:"digest"`
	Retry     *position         `json:"retry,omitempty"`
	Revisions map[string]string `json:"revisions"`
	Watches   []savedWatch      `json:"watches"`
}

// Save takes a checkpoint of the Group: its save with the router's state
// beside it. It fails as Group.Save does, with effects pending, and then
// records nothing.
func (r *Router) Save(g *talk.Group) ([]byte, error) { return r.save(groupTarget{g}) }

func (r *Router) save(t target) ([]byte, error) {
	defer r.lockGroup(t)()
	bytes, err := t.save()
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256(bytes)
	routing := routingState{Digest: hex.EncodeToString(digest[:]), Revisions: map[string]string{}, Watches: []savedWatch{}}
	if state := r.groups[t]; state != nil {
		if state.retry != nil {
			retry := *state.retry
			routing.Retry = &retry
		}
		for _, w := range r.order(keysOf(state.watches)) {
			routing.Revisions[w.store] = r.o.Revision(w.store)
			held := make([][]string, len(w.held))
			for i, h := range w.held {
				held[i] = slices.Clone(h.keys)
			}
			routing.Watches = append(routing.Watches, savedWatch{w.script, w.grant, w.name, w.store, w.prefix, w.message, w.resyncing, held})
		}
	}
	line, err := json.Marshal(routing)
	if err != nil {
		return nil, err
	}
	out := make([]byte, 0, len(header)+len(line)+1+len(bytes))
	out = append(out, header...)
	out = append(out, line...)
	out = append(out, '\n')
	return append(out, bytes...), nil
}

func invalidCheckpoint(detail string) error {
	return &talk.HostError{Code: talk.InvalidCheckpoint, Detail: detail}
}

func readCheckpoint(checkpoint []byte) (routingState, []byte, error) {
	var routing routingState
	if !strings.HasPrefix(string(checkpoint), header) {
		return routing, nil, invalidCheckpoint("A checkpoint without routing state")
	}
	rest := checkpoint[len(header):]
	end := slices.Index(rest, '\n')
	if end < 0 {
		return routing, nil, invalidCheckpoint("Unreadable routing state")
	}
	decoder := json.NewDecoder(strings.NewReader(string(rest[:end])))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&routing); err != nil || decoder.More() || !wellFormed(routing) {
		return routing, nil, invalidCheckpoint("Unreadable routing state")
	}
	save := slices.Clone(rest[end+1:])
	digest := sha256.Sum256(save)
	if hex.EncodeToString(digest[:]) != routing.Digest {
		return routing, nil, invalidCheckpoint("The routing state is for another Group save")
	}
	return routing, save, nil
}

func wellFormed(r routingState) bool {
	if len(r.Digest) != 64 || r.Revisions == nil || r.Watches == nil {
		return false
	}
	if r.Retry != nil && r.Retry.Script == "" {
		return false
	}
	for _, w := range r.Watches {
		if _, ok := r.Revisions[w.Store]; !ok || w.Script == "" || w.Grant == "" || w.Name == "" || w.Message == "" {
			return false
		}
		if w.Resyncing && len(w.Held) > 0 {
			return false
		}
		for _, keys := range w.Held {
			if len(keys) == 0 {
				return false
			}
		}
	}
	return true
}

// Restore restores a checkpoint through core.Restore with the Host's
// options, then sets up the new Group's routing before it returns. A
// checkpoint without routing state, with unreadable routing state, or whose
// digest doesn't match its save is the HostError `invalid checkpoint`; a
// failed restore returns Core.Restore's error. Either way nothing is made
// and no watch is registered.
func (r *Router) Restore(core *talk.Core, checkpoint []byte, o talk.RestoreOptions) (*talk.Group, talk.RestoreResult, RoutingResult, error) {
	var group *talk.Group
	var result talk.RestoreResult
	routing, err := r.restore(checkpoint, func(save []byte) (target, bool, error) {
		g, res, err := core.Restore(save, o)
		if err != nil {
			return nil, false, err
		}
		group, result = g, res
		return groupTarget{g}, res.VariablesOnly, nil
	}, func(script, grant, store string) bool {
		if o.Grants == nil {
			return false
		}
		g := o.Grants(script, grant)
		if g == nil || g.Capability() == nil || g.Capability().Name() != "store" {
			return false
		}
		binding, ok := g.Binding().(string)
		return ok && binding == store
	})
	if err != nil {
		return nil, talk.RestoreResult{}, RoutingResult{}, err
	}
	return group, result, routing, nil
}

// restore reads the checkpoint, restores its save with restoreGroup and
// registers each watch whose Grant is re-bound to its Store.
func (r *Router) restore(checkpoint []byte, restoreGroup func(save []byte) (target, bool, error), rebound func(script, grant, store string) bool) (RoutingResult, error) {
	out := RoutingResult{Restored: []string{}, Dropped: []string{}, Resynced: []string{}}
	routing, save, err := readCheckpoint(checkpoint)
	if err != nil {
		return out, err
	}
	t, variablesOnly, err := restoreGroup(save)
	if err != nil {
		return out, err
	}
	if variablesOnly {
		return out, nil
	}
	stores := make([]string, 0, len(routing.Revisions))
	for store := range routing.Revisions {
		stores = append(stores, store)
	}
	defer r.lock(stores...)()
	var restored, dropped []*watch
	for _, saved := range routing.Watches {
		w := &watch{group: t, script: saved.Script, grant: saved.Grant, name: saved.Name, store: saved.Store, prefix: saved.Prefix, message: saved.Message, resyncing: saved.Resyncing}
		for _, keys := range saved.Held {
			size := sizeOf(w.payload(keys, false))
			w.held = append(w.held, held{slices.Clone(keys), size})
			w.heldSize += size
		}
		if rebound(saved.Script, saved.Grant, saved.Store) {
			r.add(w)
			restored = append(restored, w)
		} else {
			dropped = append(dropped, w)
		}
	}
	if state := r.groups[t]; state != nil && routing.Retry != nil {
		retry := *routing.Retry
		state.retry = &retry
	}
	restored = r.order(restored)
	var resynced []*watch
	for _, w := range restored {
		out.Restored = append(out.Restored, w.label())
		if r.o.Revision(w.store) != routing.Revisions[w.store] {
			w.discardWork()
			w.resyncing = true
			resynced = append(resynced, w)
			out.Resynced = append(out.Resynced, w.label())
		}
	}
	// The dropped watches' Group order is the restored Group's.
	names := t.scriptNames()
	// A Script no longer in the Group sorts last, as in the order of watches.
	index := func(script string) int {
		if i := slices.Index(names, script); i >= 0 {
			return i
		}
		return len(names)
	}
	sort.SliceStable(dropped, func(i, j int) bool {
		a, b := dropped[i], dropped[j]
		if x, y := index(a.script), index(b.script); x != y {
			return x < y
		}
		if a.grant != b.grant {
			return a.grant < b.grant
		}
		return a.name < b.name
	})
	for _, w := range dropped {
		out.Dropped = append(out.Dropped, w.label())
	}
	for _, w := range resynced {
		r.drain(w)
	}
	return out, nil
}
