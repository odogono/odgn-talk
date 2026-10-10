package value

import (
	"sync"
	"sync/atomic"
)

// Maps keep a key index and an insertion-order index. Both are persistent;
// existing ordinals survive replacement, and reinsertion gets a new ordinal.
type mapView struct {
	keys     *tree[string, int]
	order    *tree[int, Pair]
	next     int
	once     sync.Once
	pairs    []Pair
	contents atomic.Int64
}

func newMapView(pairs []Pair) *mapView {
	view := &mapView{}
	for _, p := range pairs {
		view.keys = treePut(view.keys, p.Key, view.next, 1)
		view.order = treePut(view.order, view.next, p, 1)
		view.next++
	}
	return view
}
func (v Value) MapLen() int {
	if view, ok := v.data.(*mapView); ok {
		return treeTotal(view.order)
	}
	return len(v.Entries())
}

// MapEntry reads an already-normalized key; unlike Get it distinguishes a
// present Nothing from an absent key.
func (v Value) MapEntry(key string) (Value, bool) {
	if view, ok := v.data.(*mapView); ok {
		if found := treeFind(view.keys, key); found != nil {
			return treeFind(view.order, found.val).val.Val, true
		}
		return Value{}, false
	}
	for _, p := range v.Entries() {
		if p.Key == key {
			return p.Val, true
		}
	}
	return Value{}, false
}

// SetMapEntry changes one normalized key, copying only the affected paths.
func (v Value) SetMapEntry(key string, part Value, deleting bool) Value {
	view, ok := v.data.(*mapView)
	if !ok {
		view = newMapView(v.Entries())
	}
	found := treeFind(view.keys, key)
	if deleting && found == nil {
		return v
	}
	next := &mapView{keys: view.keys, order: view.order, next: view.next}
	if deleting {
		next.keys = treeRemove(view.keys, key)
		next.order = treeRemove(view.order, found.val)
	} else {
		ordinal := view.next
		if found != nil {
			ordinal = found.val
		} else {
			next.keys = treePut(view.keys, key, ordinal, 1)
			next.next++
		}
		next.order = treePut(view.order, ordinal, Pair{Key: key, Val: part}, 1)
	}
	v.data = next
	return v
}
func (v Value) MapContents(size func(Value) int64) int64 {
	if view, ok := v.data.(*mapView); ok {
		if cached := view.contents.Load(); cached != 0 {
			return cached - 1
		}
	}
	var total int64
	visit := func(p Pair) { total += int64(16+len(p.Key)) + size(p.Val) }
	if view, ok := v.data.(*mapView); ok {
		treeWalk(view.order, visit)
	} else {
		for _, p := range v.Entries() {
			visit(p)
		}
	}
	v.CacheMapContents(total)
	return total
}
func (v Value) CacheMapContents(contents int64) {
	if view, ok := v.data.(*mapView); ok {
		view.contents.Store(contents + 1)
	}
}
