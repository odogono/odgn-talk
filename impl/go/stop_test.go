package northtalk

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestStopDiscardsLiveRunsAndQueuedDecisionWithoutFinally(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: `script variable n = 0
on go, queued
 try
  wait 1 s
 finally
  put 99 into n
 end try
end go
on decide, deciding
 repeat forever
 end repeat
end decide
`})
	if err != nil {
		t.Fatal(err)
	}
	_, request, err := s.Request(nil, Message{Name: "go"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Deliver(Message{Name: "go"}); err != nil {
		t.Fatal(err)
	}
	_, active, err := s.Decide(nil, Message{Name: "decide"})
	if err != nil {
		t.Fatal(err)
	}
	_, queued, err := s.Decide(nil, Message{Name: "decide"})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Unix(0, 0)
	if _, err := g.Pump(now, PumpOptions{FuelSlice: 40}); err != nil {
		t.Fatal(err)
	}
	s.Stop("done")
	r, err := g.Pump(now, PumpOptions{})
	if err != nil || r.State != Stopped || r.FuelUsed != 0 || len(r.Reports) != 3 {
		t.Fatal(r, err)
	}
	stop := r.Reports[0].(*Stop)
	if stop.Reason != "done" || len(stop.DiscardedRuns) != 3 || len(stop.DroppedMessages) != 1 || stop.DroppedMessages[0] != "d4" {
		t.Fatal(stop)
	}
	_, failure := request.Result()
	if failure == nil || failure.Data.String() != `{reason: "stopped"}` || active.Decided().Verdict != Undecided || queued.Decided().Verdict != Undecided || g.Inspect().Scripts[0].Vars[0].Val.String() != "0" {
		t.Fatal(failure, active.Decided(), queued.Decided(), g.Inspect())
	}
}

func TestStopIsStickyAndReloadClearsReason(t *testing.T) {
	var trace lines
	g := New().NewGroup(GroupOptions{Trace: &trace})
	source := "on go\n return 5\nend go\n"
	s, err := g.Load(LoadOptions{Name: "s", Source: source})
	if err != nil {
		t.Fatal(err)
	}
	s.Stop("first")
	s.Stop("second")
	now := time.Unix(0, 0)
	r, err := g.Pump(now, PumpOptions{})
	if err != nil || len(r.Reports) != 1 || r.Reports[0].(*Stop).Reason != "first" {
		t.Fatal(r, err)
	}
	s.Stop("third")
	_, p, err := s.Request(context.Background(), Message{Name: "go"})
	if err != nil {
		t.Fatal(err)
	}
	r, err = g.Pump(now, PumpOptions{})
	_, failure := p.Result()
	if err != nil || r.FuelUsed != 0 || len(r.Reports) != 1 || r.Reports[0].(*Stop).Reason != "first" || failure == nil {
		t.Fatal(r, err, failure)
	}
	if _, err := s.Reload(source, ResetVariables); err != nil {
		t.Fatal(err)
	}
	s.Stop("new")
	r, err = g.Pump(now, PumpOptions{})
	if err != nil || len(r.Reports) != 1 || r.Reports[0].(*Stop).Reason != "new" || !strings.Contains(strings.Join(trace, "\n"), `> stop s reason="new"`) {
		t.Fatal(r, err, trace)
	}
}

func TestStopAtCapabilityCrossingRollsBackAndSkipsConversion(t *testing.T) {
	for _, mode := range []Mode{Immediate, Suspending} {
		t.Run(map[Mode]string{Immediate: "immediate", Suspending: "suspending"}[mode], func(t *testing.T) {
			c := New()
			var call *Call
			op := Operation{Name: "finish", Mode: mode, Result: NumberShape}
			stop := func(c *Call) { call = c; c.Group().Script(c.ScriptName()).Stop("crossing") }
			if mode == Immediate {
				op.Do = func(c *Call, _ []Value) (Value, error) { stop(c); return Int(7), nil }
			} else {
				op.Start = func(c *Call, _ []Value) error { stop(c); c.Answer(Int(9)); return nil }
			}
			def, err := c.DefineCapability("api", op)
			if err != nil {
				t.Fatal(err)
			}
			var trace lines
			g := c.NewGroup(GroupOptions{Trace: &trace})
			wait := ""
			if mode == Suspending {
				wait = " and wait"
			}
			s, err := g.Load(LoadOptions{Name: "s", Grants: map[string]*Grant{"api": def.GrantAll(nil)}, Source: "script variable n=0\non go, deciding\n try\n  put 9 into n\n  ask api to finish" + wait + "\n  put 8 into n\n finally\n  put 99 into n\n end try\nend go\n"})
			if err != nil {
				t.Fatal(err)
			}
			_, d, err := s.Decide(nil, Message{Name: "go"})
			if err != nil {
				t.Fatal(err)
			}
			r, err := g.Pump(time.Unix(0, 0), PumpOptions{})
			if err != nil || r.State != Stopped || len(r.Reports) != 2 || d.Decided().Verdict != Undecided || g.Inspect().Scripts[0].Vars[0].Val.String() != "0" {
				t.Fatal(r, err, d.Decided(), trace)
			}
			if s.Counters().AllocTotal != 0 || !strings.Contains(strings.Join(trace, "\n"), "end=stop") {
				t.Fatal(s.Counters(), trace)
			}
			if mode == Suspending && (call.Context().Err() == nil || len(r.Reports[0].(*Stop).PendingCalls) != 1) {
				t.Fatal(call.Context().Err(), r.Reports[0])
			}
			if mode == Suspending {
				if _, err := g.Pump(time.Unix(0, 0), PumpOptions{}); err != nil {
					t.Fatal(err)
				}
				if !strings.Contains(strings.Join(trace, "\n"), "note s/r1.c1 kind=late-answer") {
					t.Fatal(trace)
				}
			}
		})
	}
}

func TestCancellationCleanupCrossingStillConvertsResult(t *testing.T) {
	c := New()
	def, err := c.DefineCapability("api",
		Operation{Name: "cancel", Mode: Immediate, Result: NumberShape, Do: func(c *Call, _ []Value) (Value, error) {
			c.Group().Script(c.ScriptName()).CancelRun(c.RunID())
			return Int(1), nil
		}},
		Operation{Name: "value", Mode: Immediate, Result: NumberShape, Do: func(*Call, []Value) (Value, error) { return Int(7), nil }},
	)
	if err != nil {
		t.Fatal(err)
	}
	g := c.NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Grants: map[string]*Grant{"api": def.GrantAll(nil)}, Source: "script variable n=0\non go\n try\n  ask api to cancel\n finally\n  ask api to value\n  put it into n\n end try\nend go\n"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Deliver(Message{Name: "go"}); err != nil {
		t.Fatal(err)
	}
	r, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil || len(r.Reports) != 1 || r.Reports[0].(*RunEnd).Outcome != Cancelled || g.Inspect().Scripts[0].Vars[0].Val.String() != "7" || s.Counters().AllocTotal != 16 {
		t.Fatal(r, err, g.Inspect(), s.Counters())
	}
}

func TestStopAtPropertyCrossingEndsBeforeWrite(t *testing.T) {
	c := New()
	var g *Group
	k, err := c.DefineObjectKind(ObjectKindDef{Name: "switch", Props: []Prop{{Name: "value", Shape: NumberShape, Get: func(*Object) (Value, error) { g.Script("s").Stop("property"); return Int(7), nil }}}})
	if err != nil {
		t.Fatal(err)
	}
	g = c.NewGroup(GroupOptions{})
	o, _ := g.Object(k, "w", nil)
	s, err := g.Load(LoadOptions{Name: "s", Objects: map[string]*Object{"switcher": o}, Source: "script variable n=0\non go\n try\n  put 9 into n\n  put the value of switcher into n\n finally\n  put 99 into n\n end try\nend go\n"})
	if err != nil {
		t.Fatal(err)
	}
	_, p, err := s.Request(nil, Message{Name: "go"})
	if err != nil {
		t.Fatal(err)
	}
	r, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	_, failure := p.Result()
	if err != nil || len(r.Reports) != 1 || r.Reports[0].(*Stop).Reason != "property" || failure == nil || g.Inspect().Scripts[0].Vars[0].Val.String() != "0" || s.Counters().AllocTotal != 0 {
		t.Fatal(r, err, failure, s.Counters())
	}
}

func TestStopAbandonsPendingOperationAndFailsScriptSender(t *testing.T) {
	c := New()
	var call *Call
	def, err := c.DefineCapability("api", Operation{Name: "fetch", Mode: Suspending, Result: NumberShape, Start: func(c *Call, _ []Value) error { call = c; return nil }})
	if err != nil {
		t.Fatal(err)
	}
	g := c.NewGroup(GroupOptions{})
	caller, err := g.Load(LoadOptions{Name: "caller", Source: "on go\n try\n  send fetch to home and wait\n catch e\n  return the reason of e\n end try\nend go\n"})
	if err != nil {
		t.Fatal(err)
	}
	home, err := g.Load(LoadOptions{Name: "home", Grants: map[string]*Grant{"api": def.GrantAll(nil)}, Source: "on fetch\n ask api to fetch and wait\nend fetch\n"})
	if err != nil {
		t.Fatal(err)
	}
	_, p, err := caller.Request(nil, Message{Name: "go"})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Unix(0, 0)
	if _, err := g.Pump(now, PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	home.Stop("done")
	r, err := g.Pump(now, PumpOptions{})
	answer, failure := p.Result()
	if err != nil || failure != nil || answer.String() != `"stopped"` || call.Context().Err() == nil {
		t.Fatal(r, err, answer, failure)
	}
	stop := r.Reports[0].(*Stop)
	if len(stop.PendingCalls) != 1 || stop.PendingCalls[0] != call.ID() {
		t.Fatal(stop)
	}
}

func TestStopLandsAtPumpEndWithoutHostCrossing(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: "script variable n=0\non go\n put 9 into n\n repeat forever\n end repeat\nend go\n"})
	if err != nil {
		t.Fatal(err)
	}
	queued := false
	g.options.Trace = traceFunc(func(line string) {
		if !queued && strings.HasPrefix(line, "preempt ") {
			queued = true
			s.Stop("end")
		}
	})
	if _, err := s.Deliver(Message{Name: "go"}); err != nil {
		t.Fatal(err)
	}
	r, err := g.Pump(time.Unix(0, 0), PumpOptions{FuelCap: 20})
	if err != nil || r.State != Stopped || len(r.Reports) != 1 || r.Reports[0].(*Stop).Reason != "end" || g.Inspect().Scripts[0].Vars[0].Val.String() != "0" {
		t.Fatal(r, err, g.Inspect())
	}
}

func TestStopAtFailedHostChargeRemainsSticky(t *testing.T) {
	c := New()
	def, err := c.DefineCapability("api", Operation{Name: "finish", Mode: Immediate, Result: NumberShape, Do: func(call *Call, _ []Value) (Value, error) {
		call.Group().Script(call.ScriptName()).Stop("requested")
		return Nothing, call.Charge(100000)
	}})
	if err != nil {
		t.Fatal(err)
	}
	g := c.NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: "on go\n ask api to finish\nend go\n", Limits: Limits{FuelPerRun: 100}, Grants: map[string]*Grant{"api": def.GrantAll(nil)}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Deliver(Message{Name: "go"}); err != nil {
		t.Fatal(err)
	}
	now := time.Unix(0, 0)
	r, err := g.Pump(now, PumpOptions{})
	if err != nil || r.State != Stopped || len(r.Reports) != 1 {
		t.Fatal(r, err)
	}
	if stop, ok := r.Reports[0].(*Stop); !ok || stop.Reason != "requested" || len(stop.DiscardedRuns) != 1 {
		t.Fatal(r.Reports)
	}
	_, p, err := s.Request(nil, Message{Name: "go"})
	if err != nil {
		t.Fatal(err)
	}
	r, err = g.Pump(now, PumpOptions{})
	_, failure := p.Result()
	if err != nil || r.State != Stopped || r.FuelUsed != 0 || failure == nil || len(r.Reports) != 1 || r.Reports[0].(*Stop).Reason != "requested" {
		t.Fatal(r, err, failure)
	}
}

func TestStopQueuedAtPumpStartWaitsForPumpEnd(t *testing.T) {
	var trace lines
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: "on go\n return 7\nend go\n"})
	if err != nil {
		t.Fatal(err)
	}
	queued := false
	g.options.Trace = traceFunc(func(line string) {
		trace.Record(line)
		if !queued && strings.HasPrefix(line, "> pump ") {
			queued = true
			s.Stop("end")
		}
	})
	_, p, err := s.Request(nil, Message{Name: "go"})
	if err != nil {
		t.Fatal(err)
	}
	r, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	answer, failure := p.Result()
	if err != nil || r.State != Stopped || failure != nil || answer.String() != "7" || len(r.Reports) != 2 {
		t.Fatal(r, err, answer, failure, trace)
	}
	if end, ok := r.Reports[0].(*RunEnd); !ok || end.Outcome != Completed || end.Result.String() != "7" {
		t.Fatal(r.Reports)
	}
	if stop, ok := r.Reports[1].(*Stop); !ok || stop.Reason != "end" || len(stop.DiscardedRuns) != 0 || strings.Contains(strings.Join(trace, "\n"), "end=stop") {
		t.Fatal(r.Reports, trace)
	}
}

func TestStopThenDisposeKeepsOriginalReasonAndBroadcastOmitsRecipient(t *testing.T) {
	c := New()
	g := c.NewGroup(GroupOptions{})
	o, _ := g.Object(objectKindForTest(t, c, "room"), "s", nil)
	s, err := g.Load(LoadOptions{Name: "s", Owner: o, Source: "on go\n return\nend go\n"})
	if err != nil {
		t.Fatal(err)
	}
	s.Stop("first")
	if err := g.Dispose(o); err != nil {
		t.Fatal(err)
	}
	_, d, err := g.DecideBroadcast(nil, Message{Name: "go"})
	if err != nil {
		t.Fatal(err)
	}
	r, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil || len(r.Reports) != 2 || r.Reports[0].(*Stop).Reason != "first" || d.Decided().Verdict != Allowed || s.Counters().Runs != 0 {
		t.Fatal(r, err, d.Decided())
	}
	_, p, err := s.Request(nil, Message{Name: "go"})
	if err != nil {
		t.Fatal(err)
	}
	r, err = g.Pump(time.Unix(0, 0), PumpOptions{})
	_, failure := p.Result()
	if err != nil || failure == nil || r.Reports[0].(*Stop).Reason != "first" {
		t.Fatal(r, err, failure)
	}
}
