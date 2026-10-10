package value

import (
	"fmt"
	"github.com/odogono/odgn-talk/impl/go/internal/decimal"
	"runtime"
	"slices"
	"testing"
)

func collectionNumber(n int) Value {
	return Fields{Kind: Number, Number: decimal.FromInt(int64(n))}.Value()
}
func TestPersistentListEditsAndBranches(t *testing.T) {
	items := make([]Value, 1100)
	for i := range items {
		items[i] = collectionNumber(i)
	}
	current := NewList(items)
	type retained struct {
		value Value
		items []Value
	}
	var old []retained
	for step := range 1200 {
		if step%100 == 0 {
			old = append(old, retained{current, slices.Clone(items)})
		}
		at := (step * 7919) % len(items)
		part := collectionNumber(-step)
		switch step % 5 {
		case 0:
			current = current.SetListItem(at, Value{}, true)
			items = slices.Delete(items, at, at+1)
		case 1:
			current = current.ExtendList([]Value{part}, true)
			items = append([]Value{part}, items...)
		case 2:
			current = current.ExtendList([]Value{part}, false)
			items = append(items, part)
		default:
			current = current.SetListItem(at, part, false)
			items[at] = part
		}
	}
	check := func(v Value, want []Value) {
		t.Helper()
		if v.ListLen() != len(want) || !slices.EqualFunc(v.Items(), want, Value.Equal) {
			t.Fatal("List differs from flat sequence")
		}
		for i, x := range want {
			if !v.ListAt(i).Equal(x) {
				t.Fatal("indexed List differs")
			}
		}
	}
	check(current, items)
	for _, snapshot := range old {
		check(snapshot.value, snapshot.items)
		check(snapshot.value.ExtendList([]Value{Value{}}, false), append(slices.Clone(snapshot.items), Value{}))
		check(snapshot.value.ExtendList([]Value{Value{}}, true), append([]Value{{}}, snapshot.items...))
	}
	empty := NewList([]Value{{}}).SetListItem(0, Value{}, true)
	check(empty.ExtendList([]Value{collectionNumber(9)}, true), []Value{collectionNumber(9)})
}
func TestPersistentMapEditsAndOrder(t *testing.T) {
	current, _ := NewMap(nil)
	var expected []Pair
	type retained struct {
		value Value
		pairs []Pair
	}
	var old []retained
	for step := range 1600 {
		if step%100 == 0 {
			old = append(old, retained{current, slices.Clone(expected)})
		}
		key := fmt.Sprintf("key-%d", (step*73)%211)
		at := slices.IndexFunc(expected, func(p Pair) bool { return p.Key == key })
		deleting := step%4 == 0
		part := collectionNumber(step)
		if step%3 == 0 {
			part = Value{}
		}
		current = current.SetMapEntry(key, part, deleting)
		switch {
		case deleting && at >= 0:
			expected = slices.Delete(expected, at, at+1)
		case deleting:
		case at >= 0:
			expected[at].Val = part
		default:
			expected = append(expected, Pair{Key: key, Val: part})
		}
	}
	old = append(old, retained{current, expected})
	for _, snapshot := range old {
		if snapshot.value.MapLen() != len(snapshot.pairs) || !slices.EqualFunc(snapshot.value.Entries(), snapshot.pairs, func(a, b Pair) bool { return a.Key == b.Key && a.Val.Equal(b.Val) }) {
			t.Fatal("Map order or retained values changed")
		}
		for _, p := range snapshot.pairs {
			got, found := snapshot.value.MapEntry(p.Key)
			if !found || !got.Equal(p.Val) {
				t.Fatal("Map lookup or Nothing presence changed")
			}
		}
		sibling := snapshot.value.SetMapEntry("new", Value{}, false)
		if last := sibling.Entries()[sibling.MapLen()-1]; last.Key != "new" {
			t.Fatal("branched insertion lost order")
		}
	}
}

// A point edit must share untouched storage; copying a whole collection would
// make retained aliases quadratic even if the observable results still agree.
func TestCollectionPointEditAllocationDoesNotScaleWithLength(t *testing.T) {
	for _, size := range []int{512, 8192} {
		items := make([]Value, size)
		pairs := make([]Pair, size)
		for i := range pairs {
			pairs[i] = Pair{Key: fmt.Sprintf("k%06d", i)}
		}
		list := NewList(items)
		m, _ := NewMap(pairs)
		runtime.GC()
		var before, after runtime.MemStats
		runtime.ReadMemStats(&before)
		const repeats = 32
		for range repeats {
			collectionSink = list.SetListItem(size/2, Value{}, false)
			collectionSink = m.SetMapEntry("k000256", Value{}, false)
		}
		runtime.ReadMemStats(&after)
		if bytes := (after.TotalAlloc - before.TotalAlloc) / repeats; bytes > 8192 {
			t.Fatalf("%d elements: %d bytes for point edits, ceiling 8192", size, bytes)
		}
	}
}

var collectionSink Value
