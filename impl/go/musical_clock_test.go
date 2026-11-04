package northtalk

import (
	"strings"
	"testing"
)

// musicalClockForTest is a scripted musical clock: it keeps each call for
// the test to answer.
type scriptedClock struct{ calls *[]*Call }

func (s scriptedClock) Wait(call *Call, _ Value) error {
	*s.calls = append(*s.calls, call)
	return nil
}

func musicalClockForTest(t *testing.T, c *Core, calls *[]*Call) *CapabilityDef {
	t.Helper()
	def, err := c.MusicalClockCapability(scriptedClock{calls}, Costs{"wait": {Fuel: 3}})
	if err != nil {
		t.Fatal(err)
	}
	return def
}

func TestMusicalWaitWithoutAMusicalClockRaisesNoMusicalTime(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: "on go\n wait 2 bars\nend go\n"})
	if err != nil {
		t.Fatal(err)
	}
	s.Deliver(Message{Name: "go"})
	end := joinEnd(t, joinPump(t, g, 0, PumpOptions{}), "s")
	if end.Error == nil || end.Error.Code != "no musical time" {
		t.Fatal(end)
	}
}

func TestMusicalWaitCallsTheMusicalClockAndSurvivesRestore(t *testing.T) {
	c := New()
	var calls []*Call
	clock := musicalClockForTest(t, c, &calls)
	var trace lines
	g := c.NewGroup(GroupOptions{Trace: &trace}, WithMusicalClock(clock))
	if _, err := g.Load(LoadOptions{Name: "bad", Source: "on go\nend go\n", Grants: map[string]*Grant{"musical-clock": clock.GrantAll(nil)}}); err == nil {
		t.Fatal("Load accepted the reserved Grant name")
	}
	s, err := g.Load(LoadOptions{Name: "s", Source: "on go\n wait 0 beats\n wait 8 bars\n return 1\nend go\n", GrantsAsUsed: true})
	if err != nil {
		t.Fatal(err)
	}
	s.Deliver(Message{Name: "go"})
	joinPump(t, g, 0, PumpOptions{})
	if len(calls) != 1 || !strings.Contains(strings.Join(trace, "\n"), "op=musical-clock.wait args=[8 bars]") {
		t.Fatal(calls, trace)
	}
	// No MaxPending and no MaxWait: an hour later it still waits.
	joinPump(t, g, 3600, PumpOptions{})
	if calls[0].Context().Err() != nil {
		t.Fatal("musical wait timed out")
	}

	save, err := g.Save()
	if err != nil {
		t.Fatal(err)
	}
	restored, result, err := c.Restore(save, RestoreOptions{}, WithMusicalClock(clock))
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Pending) != 1 {
		t.Fatal(result.Pending)
	}
	if _, err := restored.Settle(result.Pending[0].ID, Settlement{Answer: &Value{}}); err != nil {
		t.Fatal(err)
	}
	end := joinEnd(t, joinPump(t, restored, 3601, PumpOptions{}), "s")
	if end.Outcome != Completed {
		t.Fatal(end)
	}

	calls[0].Answer(Value{})
	end = joinEnd(t, joinPump(t, g, 3601, PumpOptions{}), "s")
	if end.Outcome != Completed {
		t.Fatal(end)
	}
}

func TestMusicalWaitRefusesFractionsAndAnInvalidClock(t *testing.T) {
	c := New()
	var calls []*Call
	g := c.NewGroup(GroupOptions{}, WithMusicalClock(musicalClockForTest(t, c, &calls)))
	s, err := g.Load(LoadOptions{Name: "s", Source: "on go\n wait 1.5 bars\nend go\n"})
	if err != nil {
		t.Fatal(err)
	}
	s.Deliver(Message{Name: "go"})
	end := joinEnd(t, joinPump(t, g, 0, PumpOptions{}), "s")
	if end.Error == nil || end.Error.Code != "out of domain" || len(calls) != 0 {
		t.Fatal(end)
	}

	if _, err := c.MusicalClockCapability(scriptedClock{&calls}, Costs{}); err == nil {
		t.Fatal("MusicalClockCapability accepted no wait cost")
	}
	if _, err := c.DefineCapability("wrong", Operation{Name: "wait", Mode: Suspending, Args: []Shape{AnyShape}, Start: func(*Call, []Value) error { return nil }}); err == nil {
		t.Fatal("DefineCapability accepted wait")
	}
	plain, err := c.DefineCapability("plain", Operation{Name: "pause", Mode: Suspending, Args: []Shape{AnyShape}, Start: func(*Call, []Value) error { return nil }})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.NewGroup(GroupOptions{}, WithMusicalClock(plain)).Load(LoadOptions{Name: "s", Source: "on go\nend go\n"}); err == nil {
		t.Fatal("Load accepted a Capability that isn't a musical clock")
	}
}

func TestMusicalWaitFailureRaisesTheHostsCode(t *testing.T) {
	c := New()
	var calls []*Call
	g := c.NewGroup(GroupOptions{}, WithMusicalClock(musicalClockForTest(t, c, &calls)))
	s, err := g.Load(LoadOptions{Name: "s", Source: "on go\n try\n  wait 1 bar\n catch e\n  return the code of e\n end try\nend go\n"})
	if err != nil {
		t.Fatal(err)
	}
	s.Deliver(Message{Name: "go"})
	joinPump(t, g, 0, PumpOptions{})
	calls[0].Fail(&ScriptError{Code: "transport stopped"})
	end := joinEnd(t, joinPump(t, g, 1, PumpOptions{}), "s")
	if end.Outcome != Completed || end.Result.String() != `"transport stopped"` {
		t.Fatal(end)
	}
}
