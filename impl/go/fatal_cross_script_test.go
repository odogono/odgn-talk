package northtalk

import (
	"strings"
	"testing"
	"time"
)

func TestFatalCrossScriptControlStopsCurrentRun(t *testing.T) {
	for _, control := range []string{"stop", "stop-two", "cancel"} {
		t.Run(control, func(t *testing.T) {
			c := New()
			var trace lines
			g := c.NewGroup(GroupOptions{Trace: &trace})
			var a *Script
			marked := 0
			rollbacks := map[string]int{}
			commits := 0
			d, err := c.DefineSegmentCapability("r", SegmentLifecycle{Begin: effectOK, Commit: func(ctx SegmentContext) EffectResult { commits++; return effectOK(ctx) }, Rollback: func(ctx SegmentContext) EffectResult {
				rollbacks[ctx.ScriptName]++
				if ctx.ScriptName == "a" {
					return EffectResult{Status: EffectUnknown}
				}
				return effectOK(ctx)
			}}, Operation{Name: "write", Mode: Immediate, SegmentBound: true, Result: NothingShape, Do: func(*Call, []Value) (Value, error) { return Nothing, nil }})
			if err != nil {
				t.Fatal(err)
			}
			earlier, err := g.Load(LoadOptions{Name: "earlier", Grants: map[string]*Grant{"r": d.GrantAll(nil)}, Source: "on go\nask r to write\nrepeat forever\nend repeat\nend go"})
			if err != nil {
				t.Fatal(err)
			}
			a, err = g.Load(LoadOptions{Name: "a", Grants: map[string]*Grant{"r": d.GrantAll(nil)}, Source: "on go\nask r to write\nrepeat forever\nend repeat\nend go"})
			if err != nil {
				t.Fatal(err)
			}
			ctrl, err := c.DefineCapability("ctrl", Operation{Name: "stop", Mode: Immediate, Result: NothingShape, Do: func(*Call, []Value) (Value, error) {
				if control == "stop" || control == "stop-two" {
					a.Stop("requested")
					if control == "stop-two" {
						earlier.Stop("second")
					}
				} else {
					a.CancelRun("a/r1")
				}
				return Nothing, nil
			}}, Operation{Name: "mark", Mode: Immediate, Result: NothingShape, Do: func(*Call, []Value) (Value, error) { marked++; return Nothing, nil }})
			if err != nil {
				t.Fatal(err)
			}
			b, err := g.Load(LoadOptions{Name: "b", Grants: map[string]*Grant{"ctrl": ctrl.GrantAll(nil), "r": d.GrantAll(nil)}, Source: "on go\nask r to write\nask ctrl to stop\nask ctrl to mark\nend go"})
			if err != nil {
				t.Fatal(err)
			}
			earlier.Request(nil, Message{Name: "go"})
			a.Request(nil, Message{Name: "go"})
			b.Request(nil, Message{Name: "go"})
			r, err := g.Pump(time.Unix(0, 0), PumpOptions{FuelSlice: 100})
			if err != nil {
				t.Fatal(err)
			}
			stops := []string{}
			for _, line := range trace {
				if strings.HasPrefix(line, "stopped ") {
					stops = append(stops, strings.Fields(line)[1])
					if !strings.Contains(line, `reason="effect state unknown"`) {
						t.Fatal(line)
					}
				}
			}
			if strings.Join(stops, ",") != "earlier,a,b" {
				t.Fatal(stops, trace)
			}
			if err != nil || r.State != Stopped {
				t.Fatal(r, err)
			}
			if commits != 0 || rollbacks["earlier"] != 1 || rollbacks["a"] != 1 || rollbacks["b"] != 1 {
				t.Fatalf("commits=%d rollbacks=%v", commits, rollbacks)
			}
			if marked != 0 {
				t.Fatalf("post-fatal host effect executed %d times", marked)
			}
		})
	}
}

func TestFatalDrainedControlStopsGroupBeforeLaterControls(t *testing.T) {
	for _, control := range []string{"stop", "dispose", "reserved-reason"} {
		t.Run(control, func(t *testing.T) {
			c := New()
			var trace lines
			g := c.NewGroup(GroupOptions{Trace: &trace})
			d, err := c.DefineSegmentCapability("r", SegmentLifecycle{Begin: effectOK, Commit: effectOK, Rollback: func(SegmentContext) EffectResult { return EffectResult{Status: EffectUnknown} }}, Operation{Name: "write", Mode: Immediate, SegmentBound: true, Result: NothingShape, Do: func(*Call, []Value) (Value, error) { return Nothing, nil }})
			if err != nil {
				t.Fatal(err)
			}
			kind, err := c.DefineObjectKind(ObjectKindDef{Name: "owner"})
			if err != nil {
				t.Fatal(err)
			}
			owner, err := g.Object(kind, "one", nil)
			if err != nil {
				t.Fatal(err)
			}
			a, err := g.Load(LoadOptions{Name: "a", Owner: owner, Grants: map[string]*Grant{"r": d.GrantAll(nil)}, Source: "on go\nask r to write\nrepeat forever\nend repeat\nend go"})
			if err != nil {
				t.Fatal(err)
			}
			b, err := g.Load(LoadOptions{Name: "b", Source: "on go\nwait 1 s\nend go"})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := a.Deliver(Message{Name: "go"}); err != nil {
				t.Fatal(err)
			}
			if _, err := b.Deliver(Message{Name: "go"}); err != nil {
				t.Fatal(err)
			}
			if _, err := g.Pump(time.Unix(0, 0), PumpOptions{FuelSlice: 25}); err != nil {
				t.Fatal(err)
			}
			if control == "dispose" {
				if err := g.Dispose(owner); err != nil {
					t.Fatal(err)
				}
			} else {
				a.Stop("first")
			}
			if control == "reserved-reason" {
				b.Stop("effect state unknown")
			} else {
				b.Stop("second")
			}
			r, err := g.Pump(time.Unix(0, 0), PumpOptions{})
			if err != nil || r.State != Stopped {
				t.Fatal(r, err)
			}
			stopped := []string{}
			for _, line := range trace {
				if strings.HasPrefix(line, "stopped ") {
					stopped = append(stopped, line)
				}
			}
			if len(stopped) != 2 || stopped[0] != `stopped a reason="effect state unknown" discarded=[a/r1]` || stopped[1] != `stopped b reason="effect state unknown" discarded=[b/r1]` {
				t.Fatal(stopped)
			}
		})
	}
}
