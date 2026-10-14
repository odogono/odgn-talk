package value

import "testing"

// A value shared [v, v] n deep has 2^n logical paths through n + 1
// distinct nodes (#890). Comparisons walk distinct pairs once but
// charge every logical pair.
func sharedValue(n int, leaf Value) Value {
	v := leaf
	for range n {
		v = NewList([]Value{v, v})
	}
	return v
}

func TestSharedValueComparison(t *testing.T) {
	a := sharedValue(30, collectionNumber(1))
	b := sharedValue(30, collectionNumber(1))
	c := sharedValue(30, collectionNumber(2))
	if !a.Equal(b) || a.Equal(c) {
		t.Fatal("shared equality")
	}
	comparer := NewComparer(false)
	// Each list pair counts 1 plus its items' counts: 2^(n+1) - 2 in all.
	if scanned := comparer.Scanned(a, b); scanned != 1<<31-2 {
		t.Fatalf("scanned=%d", scanned)
	}
	// A differing leaf is found down the first path: 30 item pairs, then
	// the number pair counts 0.
	if scanned := comparer.Scanned(a, c); scanned != 30 {
		t.Fatalf("differing scanned=%d", scanned)
	}
	if order, err := comparer.Compare(a, c); err != nil || order >= 0 {
		t.Fatalf("order=%d err=%v", order, err)
	}
	if comparer.SelfScan(a) != 1<<31-2 {
		t.Fatalf("self scan=%d", comparer.SelfScan(a))
	}
}
