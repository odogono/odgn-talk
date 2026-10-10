package machine

import (
	"os"
	"testing"
)

func TestCollectionEditsAccountingAndRollback(t *testing.T) {
	source, err := os.ReadFile("../../../testdata/collection-edits.talk")
	if err != nil {
		t.Fatal(err)
	}
	state, err := Initialize(compile(t, string(source)))
	if err != nil {
		t.Fatal(err)
	}
	original := state.Variables[0]
	first := StartDelivery(state, "edit", nil, Limits{Fuel: 100_000, Alloc: 1_000_000, Depth: 100}, false)
	first.PolicyDispatch = false
	first.Execute(0)
	// Same output, Fuel and logical allocation as e35980e9, before structural sharing.
	if first.Status != Completed || first.Fuel != 4409 || first.Alloc != 18059 {
		t.Fatalf("status=%v fuel=%d alloc=%d", first.Status, first.Fuel, first.Alloc)
	}
	result := first.Result
	if !result.ListAt(0).Equal(original) || result.ListAt(1).MapLen() != 82 || result.ListAt(2).ListAt(1).Display() != "2" || result.ListAt(3).ListAt(1).Display() != "80" {
		t.Fatal("collection alias changed")
	}
	entries := result.ListAt(4).Entries()
	if entries[len(entries)-1].Key != "é" {
		t.Fatal("reinsertion did not move to the end")
	}
	retained := result.Display()
	for _, limits := range []Limits{{Fuel: 800, Alloc: 1_000_000, Depth: 100}, {Fuel: 100_000, Alloc: 1000, Depth: 100}} {
		fault := StartDelivery(state, "fault", nil, limits, false)
		fault.PolicyDispatch = false
		for fault.Status == Running || fault.Status == Preempted {
			fault.Execute(7)
		}
		if fault.Status != Faulted || !state.Variables[0].Equal(original) || result.Display() != retained {
			t.Fatal("rollback changed retained collections")
		}
	}
}
