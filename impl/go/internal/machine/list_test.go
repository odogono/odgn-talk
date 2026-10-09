package machine

import (
	"os"
	"slices"
	"testing"

	"github.com/odogono/odgn-talk/impl/go/internal/value"
)

func TestListGrowthAliasesAndRollback(t *testing.T) {
	source, err := os.ReadFile("../../../testdata/list-growth.talk")
	if err != nil {
		t.Fatal(err)
	}
	state, err := Initialize(compile(t, string(source)))
	if err != nil {
		t.Fatal(err)
	}
	limits := Limits{Fuel: 100_000, Alloc: 1_000_000, Depth: 100}
	const want = `[[[1, 2], [0, 9, 2, 3, 4, 0, 1, 2, 3, 4], [-1, 1, 2, 3, 5, -1, 1, 2, 3, 5]], 128, 1, 64, [1, 2, 3], [1, 2, 3, 4, 5, 6, 7, 8, 1, 2, 3]]`
	first := StartDelivery(state, "grow", nil, limits, false)
	first.PolicyDispatch = false
	first.Execute(0)
	if first.Status != Completed || first.Result.Display() != want {
		t.Fatalf("status=%v result=%s raises=%v", first.Status, first.Result.Display(), first.Raises)
	}
	// Verified against the slice-copying Core at 2372361.
	if first.Fuel != 1979 || first.Alloc != 6664 {
		t.Fatalf("fuel=%d alloc=%d", first.Fuel, first.Alloc)
	}
	for _, faultLimits := range []Limits{
		{Fuel: 200, Alloc: 1_000_000, Depth: 100},
		{Fuel: 100_000, Alloc: 200, Depth: 100},
	} {
		fault := StartDelivery(state, "fault", nil, faultLimits, false)
		fault.PolicyDispatch = false
		// Preemption keeps the same Segment checkpoint and List aliases alive.
		for fault.Status == Running || fault.Status == Preempted {
			fault.Execute(7)
		}
		if fault.Status != Faulted || state.Variables[0].Display() != "[1, 2]" {
			t.Fatalf("status=%v limit=%s values=%s", fault.Status, fault.Limit, state.Variables[0].Display())
		}
		if first.Result.Display() != want {
			t.Fatal("a retained result changed during a later Run")
		}
		again := StartDelivery(state, "grow", nil, limits, false)
		again.PolicyDispatch = false
		again.Execute(0)
		if again.Status != Completed || again.Result.Display() != want || again.Fuel != first.Fuel || again.Alloc != first.Alloc {
			t.Fatalf("repeated growth differs: status=%v fuel=%d alloc=%d result=%s", again.Status, again.Fuel, again.Alloc, again.Result.Display())
		}
	}
}

func TestListGrowthNestedContentsAndDetachedSlices(t *testing.T) {
	nested := value.NewList([]value.Value{text("é"), value.NewList([]value.Value{integer(7)})})
	current := value.NewList([]value.Value{nested})
	retained := current
	for i := range 2000 {
		current = extendList(current, []value.Value{nested}, i%2 != 0)
	}
	if Size(current) != Size(retained)+2000*(8+Size(nested)) || len(retained.Items) != 1 {
		t.Fatal("growth changed logical size or the retained view")
	}
	sibling := extendList(retained, []value.Value{integer(9)}, false)
	if sibling.Display() != `[["é", [7]], 9]` || !current.Items[0].Equal(nested) || !current.Items[2000].Equal(nested) {
		t.Fatal("growth changed shared nested values")
	}
	// Folding, Trace display and Library binding replace Items on a Value
	// copy. Their new slices must not inherit the old window's cached size.
	detached := current
	detached.Items = slices.Clone(current.Items)
	detached.Items[0] = text("a different length")
	if Size(detached) != Size(value.NewList(detached.Items)) {
		t.Fatal("detached slice used stale contents")
	}
	grown := extendList(detached, []value.Value{integer(10)}, false)
	if !grown.Items[0].Equal(detached.Items[0]) || !current.Items[0].Equal(nested) {
		t.Fatal("detached slice grew the old buffer")
	}
}
