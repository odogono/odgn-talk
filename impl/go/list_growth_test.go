package northtalk

import (
	"os"
	"testing"
	"time"
)

func TestListGrowthSaveRestoresRollbackCheckpoint(t *testing.T) {
	source, err := os.ReadFile("../testdata/list-growth.talk")
	if err != nil {
		t.Fatal(err)
	}
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: string(source), Limits: Limits{FuelPerRun: 2500}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Deliver(Message{Name: "grow"}); err != nil {
		t.Fatal(err)
	}
	if _, err = g.Pump(time.Unix(0, 0), PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	retained := g.Inspect().Scripts[0].Vars[0].Val
	if _, err = s.Deliver(Message{Name: "fault"}); err != nil {
		t.Fatal(err)
	}
	if _, err = g.Pump(time.Unix(1, 0), PumpOptions{FuelSlice: 100}); err != nil {
		t.Fatal(err)
	}
	if g.Inspect().Scripts[0].Vars[0].Val.Len() <= 2 || retained.String() != "[1, 2]" {
		t.Fatal("preempted growth changed its checkpoint or retained Host value")
	}
	saved, err := g.Save()
	if err != nil {
		t.Fatal(err)
	}
	copy, _, err := New().Restore(saved, RestoreOptions{})
	if err != nil {
		t.Fatal(err)
	}
	original, err := g.Pump(time.Unix(2, 0), PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	resumed, err := copy.Pump(time.Unix(2, 0), PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if resumed.FuelUsed != original.FuelUsed || copy.Inspect().Scripts[0].Vars[0].Val.String() != "[1, 2]" {
		t.Fatal("restored growth changed charges or failed to roll back")
	}
	if retained.String() != "[1, 2]" {
		t.Fatal("rollback changed a retained Host value")
	}
	if _, err = copy.Script("s").Deliver(Message{Name: "grow"}); err != nil {
		t.Fatal(err)
	}
	if _, err = copy.Pump(time.Unix(3, 0), PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	if copy.Inspect().Scripts[0].Vars[0].Val.String() != "[1, 2]" {
		t.Fatal("growth from a restored List changed its original")
	}
}
