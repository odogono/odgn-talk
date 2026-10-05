package northtalk

import (
	"testing"
	"time"
)

func TestExtendKeepsSuspendedRunAndDefinitions(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: "script variable n = 1\nconstant offset = 2\nfunction plus x, y = 3\n return x + y + offset\nend plus\non old\n wait 1 s\n put n + 1 into n\nend old"})
	if err != nil {
		t.Fatal(err)
	}
	s.Deliver(Message{Name: "old"})
	if _, err = g.Pump(time.Unix(0, 0), PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	if err = s.Extend("script variable fresh = offset + 5\non newone\n put plus(fresh) into n\nend newone"); err != nil {
		t.Fatal(err)
	}
	s.Deliver(Message{Name: "newone"})
	g.Pump(time.Unix(0, 0), PumpOptions{})
	g.Pump(time.Unix(1, 0), PumpOptions{})
	if got := g.Inspect().Scripts[0].Vars[0].Val.String(); got != "13" {
		t.Fatalf("n = %s, want 13", got)
	}
}

func TestExtendChecksInheritedSuspendingHandler(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: "on old\n wait 1 s\nend old"})
	if err != nil {
		t.Fatal(err)
	}
	if err = s.Extend("on bad\n old\nend bad"); err == nil {
		t.Fatal("accepted a plain call to inherited suspending Handler")
	}
}
func TestExtendLinksNewLibrary(t *testing.T) {
	c := New()
	g := c.NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: "on old\nend old"})
	if err != nil {
		t.Fatal(err)
	}
	l, err := c.CompileLibrary(LibrarySource{Name: "fresh", Source: "function foo\n return 7\nend foo"}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = g.AddLibrary(l); err != nil {
		t.Fatal(err)
	}
	if err = s.Extend("use foo from fresh\non go\n return foo()\nend go"); err != nil {
		t.Fatal(err)
	}
	s.Deliver(Message{Name: "go"})
	r, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Reports) != 1 || r.Reports[0].(*RunEnd).Result.String() != "7" {
		t.Fatal(r.Reports)
	}
}
func TestExtendRebindsFunctionInPreemptedRollbackBase(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: "on spin\n repeat forever\n end repeat\nend spin", Limits: Limits{FuelPerRun: 100}})
	if err != nil {
		t.Fatal(err)
	}
	s.Deliver(Message{Name: "spin"})
	g.Pump(time.Unix(0, 0), PumpOptions{FuelSlice: 10})
	if err = s.Extend("script variable cb = given x: x + 1\non go\n return cb(2)\nend go"); err != nil {
		t.Fatal(err)
	}
	g.Pump(time.Unix(0, 0), PumpOptions{})
	s.Deliver(Message{Name: "go"})
	r, _ := g.Pump(time.Unix(0, 0), PumpOptions{})
	if len(r.Reports) != 1 || r.Reports[0].(*RunEnd).Result.String() != "3" {
		t.Fatal(r.Reports)
	}
}

func TestExtendCannotCallInheritedVetoHandler(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: "on guarded, deciding\n veto\nend guarded"})
	if err != nil {
		t.Fatal(err)
	}
	if err = s.Extend("on caller\n guarded\nend caller"); err == nil {
		t.Fatal("accepted a local call into inherited veto")
	}
}

func TestExtendChecksOnlyNewCodeAgainstUnrevokedGrants(t *testing.T) {
	c := New()
	def, err := c.DefineCapability("cap", Operation{Name: "get", Mode: Immediate, Result: NothingShape, Do: func(*Call, []Value) (Value, error) { return Nothing, nil }})
	if err != nil {
		t.Fatal(err)
	}
	g := c.NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: "on old\n ask r to get\nend old", Grants: map[string]*Grant{"r": def.GrantAll(nil)}})
	if err != nil {
		t.Fatal(err)
	}
	s.Revoke("r")
	g.Pump(time.Unix(1, 0), PumpOptions{})
	if err = s.Extend("on fresh\n ask r to get\nend fresh"); err == nil {
		t.Fatal("new code accepted revoked Grant")
	}
	if err = s.Extend("on fresh\nend fresh"); err != nil {
		t.Fatal("old code incorrectly rechecked", err)
	}
}

func TestExtendDoesNotRecheckPriorBuiltinCalls(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: "on old\n return abs(-2)\nend old"})
	if err != nil {
		t.Fatal(err)
	}
	if err = s.Extend("on abs x\n wait 1 s\nend abs"); err != nil {
		t.Fatal(err)
	}
	s.Deliver(Message{Name: "old"})
	result, err := g.Pump(time.Unix(1, 0), PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Reports) != 1 || result.Reports[0].(*RunEnd).Result.String() != "2" {
		t.Fatal(result.Reports)
	}
}
