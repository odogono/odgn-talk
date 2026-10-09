package value

import (
	"slices"
	"sync"
	"testing"

	"github.com/odogono/odgn-talk/impl/go/internal/decimal"
)

func TestListGrowthConcurrentBranches(t *testing.T) {
	item := func(n int) Value { return Value{Kind: Number, Number: decimal.FromInt(int64(n))} }
	base := NewList(nil).ExtendList([]Value{item(1)}, false)
	var workers sync.WaitGroup
	for i := 2; i <= 65; i++ {
		workers.Go(func() {
			grown := base.ExtendList([]Value{item(i)}, false).ExtendList([]Value{item(-i)}, true)
			want := []Value{item(-i), item(1), item(i)}
			if !slices.EqualFunc(grown.Items, want, Value.Equal) {
				t.Error("concurrent branch changed another List")
			}
		})
	}
	workers.Wait()
	if len(base.Items) != 1 || !base.Items[0].Equal(item(1)) {
		t.Fatal("concurrent branches changed their source")
	}
}
