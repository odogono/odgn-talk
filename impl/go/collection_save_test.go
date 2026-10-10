package northtalk

import (
	"os"
	"slices"
	"testing"
	"time"
)

func TestSaveRestoresPersistentCollectionCheckpoint(t *testing.T) {
	source, err := os.ReadFile("../testdata/collection-edits.talk")
	if err != nil {
		t.Fatal(err)
	}
	var original, resumed lines
	g := New().NewGroup(GroupOptions{Name: "original", Trace: &original})
	s, err := g.Load(LoadOptions{Name: "s", Source: string(source), Limits: Limits{FuelPerRun: 800}})
	if err != nil {
		t.Fatal(err)
	}
	before := g.Inspect().Scripts[0].Vars[0].Val.String()
	if _, err = s.Deliver(Message{Name: "fault"}); err != nil {
		t.Fatal(err)
	}
	if _, err = g.Pump(time.Unix(1, 0), PumpOptions{FuelSlice: 100}); err != nil {
		t.Fatal(err)
	}
	if g.Inspect().Scripts[0].Vars[0].Val.String() == before {
		t.Fatal("checkpoint fixture did not edit collections")
	}
	saved, err := g.Save()
	if err != nil {
		t.Fatal(err)
	}
	copy, _, err := New().Restore(saved, RestoreOptions{Name: "resumed", Trace: &resumed})
	if err != nil {
		t.Fatal(err)
	}
	original = nil
	resumed = nil
	if _, err = g.Pump(time.Unix(2, 0), PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, err = copy.Pump(time.Unix(2, 0), PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(original, resumed) {
		t.Fatalf("resumed Trace differs:\n%v\n%v", original, resumed)
	}
	if copy.Inspect().Scripts[0].Vars[0].Val.String() != before {
		t.Fatal("restored checkpoint did not roll back")
	}
}
