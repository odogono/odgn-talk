package value

import (
	"bytes"
	"fmt"
	"math"
	"strings"

	coreunicode "northtalk.org/go/internal/unicode"
)

// A Comparer carries one comparison's shared work (#890): equality walks
// each distinct pair of nodes once, however many paths reach it, while
// Scanned still counts every logical pair examined, shared parts at each
// occurrence. The Fuel charge is logical; the native work is not.
type Comparer struct {
	Fold      bool
	proven    map[pairKey]bool
	selfScans map[any]int64
}

type pairKey struct{ a, b any }

func NewComparer(fold bool) *Comparer {
	return &Comparer{Fold: fold, proven: map[pairKey]bool{}, selfScans: map[any]int64{}}
}

// identity is the node's own pointer, for kinds whose payload has one.
// Two Values with one identity are the same node, so they are equal and
// a pair of identities needs proving only once. Other kinds are leaves
// or hold only leaves, and need no memo.
func identity(v Value) (any, bool) {
	switch v.data.(type) {
	case *listView, *mapView, *FunctionData:
		return v.data, true
	}
	return nil, false
}

func scanAdd(a, b int64) int64 {
	if a >= math.MaxInt64-b {
		return math.MaxInt64
	}
	return a + b
}

func foldedText(v Value) string {
	s, _ := coreunicode.Fold(v.Text())
	return s
}

// Equal is Script equality (chapter 3), comparing texts by their simple
// case foldings when the Comparer folds.
func (c *Comparer) Equal(a, b Value) bool {
	if a.Kind != b.Kind {
		return false
	}
	ia, oka := identity(a)
	ib, okb := identity(b)
	memo := oka && okb
	if memo {
		if ia == ib || c.proven[pairKey{ia, ib}] {
			return true
		}
	}
	same := c.equalNodes(a, b)
	if same && memo {
		c.proven[pairKey{ia, ib}] = true
	}
	return same
}

func (c *Comparer) equalNodes(v, w Value) bool {
	switch v.Kind {
	case Nothing:
		return true
	case Boolean:
		return v.Bool == w.Bool
	case Number:
		return v.Number().Compare(w.Number()) == 0
	case Quantity:
		if !v.Unit().Compatible(w.Unit()) {
			return false
		}
		return quantityOrder(v, w) == 0
	case Text:
		if c.Fold {
			return foldedText(v) == foldedText(w)
		}
		return v.Text() == w.Text()
	case Pattern:
		return v.Text() == w.Text()
	case Bytes:
		return bytes.Equal(v.Bytes(), w.Bytes())
	case List, Range:
		if len(v.Items()) != len(w.Items()) {
			return false
		}
		for i, a := range v.Items() {
			if !c.Equal(a, w.Items()[i]) {
				return false
			}
		}
		return true
	case Map:
		if v.MapLen() != w.MapLen() {
			return false
		}
		if c.Fold {
			matches, _ := c.matchEntries(v.Entries(), w.Entries())
			return matches
		}
		for _, p := range v.Entries() {
			other, found := w.MapEntry(p.Key)
			if !found || !c.Equal(p.Val, other) {
				return false
			}
		}
		return true
	case CivilDate:
		return v.Date() == w.Date()
	case Instant:
		return v.Seconds() == w.Seconds() && v.Micros() == w.Micros()
	case Object:
		return v.Object() != nil && w.Object() != nil && v.Object().Handle == w.Object().Handle
	case Function:
		if v.Function() == nil || w.Function() == nil || v.Function().Home != w.Function().Home || v.Function().Code != w.Function().Code || v.Function().Group != w.Function().Group {
			return false
		}
		if c.Fold {
			if len(v.Function().Captures) != len(w.Function().Captures) {
				return false
			}
			matches, _ := c.matchEntries(v.Function().Captures, w.Function().Captures)
			return matches
		}
		return (Fields{Kind: Map, Entries: v.Function().Captures}.Value()).Equal(Fields{Kind: Map, Entries: w.Function().Captures}.Value())
	}
	return false
}

// matchEntries is folded map matching and its scanned count. Keys are
// never stored folded: two distinct keys can have the same fold, so
// entries match one-to-one, in the left map's insertion order, which
// keeps equality reflexive and order-insensitive for such maps. Scanned
// counts each entry examined through the first with no match, plus what
// comparing its value with the matched entry's scans.
func (c *Comparer) matchEntries(left, right []Pair) (bool, int64) {
	used := make([]bool, len(right))
	var scanned int64
	for i, p := range left {
		if i >= len(right) {
			return false, scanned
		}
		scanned = scanAdd(scanned, 1)
		found := false
		for j, q := range right {
			if !used[j] && c.Equal(textValue(p.Key), textValue(q.Key)) && c.Equal(p.Val, q.Val) {
				used[j], found = true, true
				scanned = scanAdd(scanned, c.SelfScan(p.Val))
				break
			}
		}
		if !found {
			return false, scanned
		}
	}
	return len(left) == len(right), scanned
}

func textValue(s string) Value {
	return Fields{Kind: Text, Text: s}.Value()
}

// Compare is chapter 3's ordering, folded when the Comparer folds. It
// reports the first unequal list pair, so a later unorderable value
// cannot mask an earlier ordering decision.
func (c *Comparer) Compare(v, w Value) (int, error) {
	if v.Kind != w.Kind {
		return 0, fmt.Errorf("can't compare: %s and %s", v.Display(), w.Display())
	}
	switch v.Kind {
	case Number:
		return v.Number().Compare(w.Number()), nil
	case Quantity:
		if v.Unit().Compatible(w.Unit()) {
			return quantityOrder(v, w), nil
		}
	case Text:
		if c.Fold {
			return strings.Compare(foldedText(v), foldedText(w)), nil // UTF-8 preserves scalar order.
		}
		return strings.Compare(v.Text(), w.Text()), nil
	case Bytes:
		return bytes.Compare(v.Bytes(), w.Bytes()), nil
	case Instant:
		if v.Seconds() != w.Seconds() {
			if v.Seconds() < w.Seconds() {
				return -1, nil
			}
			return 1, nil
		}
		return cmpInt(int(v.Micros()), int(w.Micros())), nil
	case CivilDate:
		if v.Date().HasTime == w.Date().HasTime {
			a, b := v.Date(), w.Date()
			for _, p := range [][2]int{{a.Year, b.Year}, {a.Month, b.Month}, {a.Day, b.Day}, {a.Hour, b.Hour}, {a.Minute, b.Minute}, {a.Second, b.Second}, {a.Microsecond, b.Microsecond}} {
				if n := cmpInt(p[0], p[1]); n != 0 {
					return n, nil
				}
			}
			return 0, nil
		}
	case List:
		for i := 0; i < min(len(v.Items()), len(w.Items())); i++ {
			if !c.Equal(v.Items()[i], w.Items()[i]) {
				return c.Compare(v.Items()[i], w.Items()[i])
			}
		}
		return cmpInt(len(v.Items()), len(w.Items())), nil
	}
	return 0, fmt.Errorf("can't compare: %s and %s", v.Display(), w.Display())
}

// scanChildren are the values whose pairs comparing v with itself
// examines, each counted with its pair (a range's ends without).
func scanChildren(v Value) []Value {
	switch v.Kind {
	case List, Range:
		return v.Items()
	case Map:
		items := make([]Value, 0, v.MapLen())
		for _, p := range v.Entries() {
			items = append(items, p.Val)
		}
		return items
	case Function:
		if v.Function() == nil {
			return nil
		}
		items := make([]Value, 0, len(v.Function().Captures))
		for _, p := range v.Function().Captures {
			items = append(items, p.Val)
		}
		return items
	}
	return nil
}

// SelfScan is what comparing a value with itself scans: every logical
// pair in it. An equal pair scans this much, from either side. Shared
// parts are measured once and counted at each occurrence.
func (c *Comparer) SelfScan(v Value) int64 {
	if id, ok := identity(v); ok {
		if n, seen := c.selfScans[id]; seen {
			return n
		}
	}
	var total int64
	switch v.Kind {
	case Text:
		s := v.Text()
		if c.Fold {
			s = foldedText(v)
		}
		b, _ := coreunicode.Boundaries(s)
		total = int64(max(0, len(b)-1))
	case Bytes:
		total = int64(len(v.Bytes()))
	case List, Map, Function:
		for _, child := range scanChildren(v) {
			total = scanAdd(total, scanAdd(1, c.SelfScan(child)))
		}
	case Range:
		for _, child := range scanChildren(v) {
			total = scanAdd(total, c.SelfScan(child))
		}
	}
	if id, ok := identity(v); ok {
		c.selfScans[id] = total
	}
	return total
}

// Scanned is the logical pairs a comparison of a with b examines,
// through the first that differs, at every depth (chapter 8, the
// `compare` rate). Only the first differing path is descended; equal
// parts contribute their self-scan.
func (c *Comparer) Scanned(a, b Value) int64 {
	if a.Kind != b.Kind {
		return 0
	}
	switch a.Kind {
	case Text:
		as, bs := a.Text(), b.Text()
		if c.Fold {
			as, bs = foldedText(a), foldedText(b)
		}
		ab, _ := coreunicode.Boundaries(as)
		bb, _ := coreunicode.Boundaries(bs)
		for j := 0; j < min(len(ab), len(bb))-1; j++ {
			if as[ab[j]:ab[j+1]] != bs[bb[j]:bb[j+1]] {
				return int64(j + 1)
			}
		}
		return int64(max(0, min(len(ab), len(bb))-1))
	case Bytes:
		for j := 0; j < min(len(a.Bytes()), len(b.Bytes())); j++ {
			if a.Bytes()[j] != b.Bytes()[j] {
				return int64(j + 1)
			}
		}
		return int64(min(len(a.Bytes()), len(b.Bytes())))
	case List:
		var total int64
		for j := 0; j < min(len(a.Items()), len(b.Items())); j++ {
			total = scanAdd(total, 1)
			if c.Equal(a.Items()[j], b.Items()[j]) {
				total = scanAdd(total, c.SelfScan(a.Items()[j]))
			} else {
				return scanAdd(total, c.Scanned(a.Items()[j], b.Items()[j]))
			}
		}
		return total
	case Map:
		if c.Fold {
			_, scanned := c.matchEntries(a.Entries(), b.Entries())
			return scanned
		}
		var total int64
		for i, p := range a.Entries() {
			if i >= len(b.Entries()) {
				break
			}
			total = scanAdd(total, 1)
			other, found := b.MapEntry(p.Key)
			if !found {
				break
			}
			if c.Equal(p.Val, other) {
				total = scanAdd(total, c.SelfScan(p.Val))
			} else {
				return scanAdd(total, c.Scanned(p.Val, other))
			}
		}
		return total
	case Range:
		if !c.Equal(a.Items()[0], b.Items()[0]) {
			return c.Scanned(a.Items()[0], b.Items()[0])
		}
		first := c.SelfScan(a.Items()[0])
		if c.Equal(a.Items()[1], b.Items()[1]) {
			return scanAdd(first, c.SelfScan(a.Items()[1]))
		}
		return scanAdd(first, c.Scanned(a.Items()[1], b.Items()[1]))
	case Function:
		if a.Function() == nil || b.Function() == nil || a.Function().Home != b.Function().Home || a.Function().Code != b.Function().Code || a.Function().Group != b.Function().Group || len(a.Function().Captures) != len(b.Function().Captures) {
			return 0
		}
		if c.Fold {
			_, scanned := c.matchEntries(a.Function().Captures, b.Function().Captures)
			return scanned
		}
		var total int64
		for _, p := range a.Function().Captures {
			total = scanAdd(total, 1)
			var other Value
			found := false
			for _, q := range b.Function().Captures {
				if q.Key == p.Key {
					other, found = q.Val, true
					break
				}
			}
			if !found {
				break
			}
			if c.Equal(p.Val, other) {
				total = scanAdd(total, c.SelfScan(p.Val))
			} else {
				return scanAdd(total, c.Scanned(p.Val, other))
			}
		}
		return total
	}
	return 0
}

// DeepScan summarises a deep scan of a value (chapter 7's `any` scan):
// whether it holds no Function Value, and how many logical nodes the
// scan examines, shared parts at each occurrence.
type DeepScan struct {
	Clean bool
	Nodes int64
}

// DeepScanOf measures v for a deep scan, walking each distinct node
// once however often it is shared (#890). The cache, keyed by node
// identity, is the caller's to keep across scans in one check; pass
// the same map to reuse what earlier scans proved.
func DeepScanOf(v Value, cache map[any]DeepScan) DeepScan {
	pending := []Value{v}
	var order []Value
	seen := map[any]bool{}
	for len(pending) > 0 {
		next := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		id, ok := identity(next)
		if ok {
			if _, done := cache[id]; done || seen[id] {
				continue
			}
			seen[id] = true
		}
		order = append(order, next)
		switch next.Kind {
		case List:
			pending = append(pending, next.Items()...)
		case Map:
			for _, p := range next.Entries() {
				pending = append(pending, p.Val)
			}
		}
	}
	var result DeepScan
	for i := len(order) - 1; i >= 0; i-- {
		value := order[i]
		scan := DeepScan{Clean: value.Kind != Function, Nodes: 1}
		var children []Value
		switch value.Kind {
		case List:
			children = value.Items()
		case Map:
			for _, p := range value.Entries() {
				children = append(children, p.Val)
			}
		}
		for _, child := range children {
			info := scanOf(child, cache)
			scan.Clean = scan.Clean && info.Clean
			scan.Nodes = scanAdd(scan.Nodes, info.Nodes)
		}
		if id, ok := identity(value); ok {
			cache[id] = scan
		}
		if i == 0 {
			result = scan
		}
	}
	if id, ok := identity(v); ok {
		if scan, done := cache[id]; done {
			return scan
		}
	}
	return result
}

func scanOf(v Value, cache map[any]DeepScan) DeepScan {
	if id, ok := identity(v); ok {
		if scan, done := cache[id]; done {
			return scan
		}
	}
	// A child with no identity was measured on this walk only when it
	// also appears in the order list; measure it directly.
	return DeepScanOf(v, cache)
}
