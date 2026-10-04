package northtalk

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestSuspendingOperationQueuesAnAnswerDuringStart(t *testing.T) {
	core := New()
	var call *Call
	starts, ready := 0, 0
	def, err := core.DefineCapability(t.Name(), Operation{Name: "fetch", Mode: Suspending, Result: NumberShape, Cost: Cost{Fuel: 7}, MaxPending: 3 * time.Second, Start: func(c *Call, args []Value) error {
		call = c
		starts++
		if _, err := c.Group().Pump(c.Now(), PumpOptions{}); err == nil {
			t.Fatal("worker reentry accepted")
		}
		answer, ok := any(c).(interface{ AnswerWithCost(Value, int64) })
		if !ok {
			t.Fatal("Call has no AnswerWithCost")
		}
		answer.AnswerWithCost(Int(9), 5)
		return nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	var trace lines
	g := core.NewGroup(GroupOptions{Trace: &trace, OnReady: func() { ready++ }})
	s, err := g.Load(LoadOptions{Name: "s", Source: "on go\nask api to fetch and wait\nreturn it\nend", Grants: map[string]*Grant{"api": def.GrantAll("tenant")}})
	if err != nil {
		t.Fatal(err)
	}
	_, p, err := s.Request(context.Background(), Message{Name: "go"})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 4, 12, 0, 0, 0, time.UTC)
	first, err := g.Pump(now, PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if starts != 1 || call == nil {
		t.Fatalf("Start invoked %d times", starts)
	}
	select {
	case <-p.Done():
		t.Fatal("answer ran waiting Run in starting Pump")
	default:
	}
	view := g.Inspect().Scripts[0].Runs[0]
	if view.Status != Suspended || view.Wait != "ask-wait" || len(view.Calls) != 1 || view.Calls[0] != call.ID() || !first.NextDeadline.Equal(now.Add(3*time.Second)) {
		t.Fatalf("%+v %+v", view, first)
	}
	second, err := g.Pump(now, PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	v, e := p.Result()
	if e != nil || !v.Equal(Int(9)) || len(second.Reports) != 1 || ready != 2 || starts != 1 {
		t.Fatalf("%v %v %+v ready=%d", v, e, second, ready)
	}
	if call.Charge(1) == nil {
		t.Fatal("Charge accepted after Start")
	}
	if call.Context().Err() != nil {
		t.Fatal("answered context cancelled")
	}
	if !strings.Contains(strings.Join(trace, "\n"), "end=ask-wait") {
		t.Fatal(trace)
	}
}

func suspendingLoad(t *testing.T, op Operation, source string, limits Limits) (*Group, *Script, *[]*Call, *lines) {
	t.Helper()
	core := New()
	calls := []*Call{}
	start := op.Start
	op.Name = "fetch"
	op.Mode = Suspending
	op.Start = func(c *Call, args []Value) error {
		calls = append(calls, c)
		if start != nil {
			return start(c, args)
		}
		return nil
	}
	d, e := core.DefineCapability(t.Name(), op)
	if e != nil {
		t.Fatal(e)
	}
	trace := lines{}
	g := core.NewGroup(GroupOptions{Trace: &trace})
	s, e := g.Load(LoadOptions{Name: "s", Source: source, Limits: limits, Grants: map[string]*Grant{"api": d.GrantAll(nil)}})
	if e != nil {
		t.Fatal(e)
	}
	return g, s, &calls, &trace
}

func TestSuspendingOperationWorkerSettlementsAndRevocation(t *testing.T) {
	g, s, calls, trace := suspendingLoad(t, Operation{Result: NumberShape}, "on go\nask api to fetch and wait\nreturn it\nend", Limits{})
	s.Deliver(Message{Name: "go"})
	joinPump(t, g, 0, PumpOptions{})
	c := (*calls)[0]
	s.Revoke("api")
	done := make(chan struct{})
	go func() { c.Answer(Int(7)); c.Answer(Int(8)); c.Fail(nil); close(done) }()
	<-done
	r := joinPump(t, g, 1, PumpOptions{})
	end := joinEnd(t, r, "s")
	if end.Outcome != Completed || end.Result.String() != "7" || c.Context().Err() != nil {
		t.Fatalf("%+v", end)
	}
	records := strings.Join(*trace, "\n")
	if !strings.Contains(records, "note s/r1.c1 kind=late-answer") || !strings.Contains(records, "note s/r1.c1 kind=late-fail") {
		t.Fatal(records)
	}
	s.Deliver(Message{Name: "go"})
	end = joinEnd(t, joinPump(t, g, 1, PumpOptions{}), "s")
	if end.Error == nil || end.Error.Code != "capability revoked" || len(*calls) != 1 {
		t.Fatal(end)
	}
}

func TestSuspendingOperationFailuresAndResumeLimits(t *testing.T) {
	for _, test := range []struct {
		name        string
		settle      func(*Call)
		start       func(*Call, []Value) error
		limits      Limits
		result      Shape
		code, limit string
		detail      bool
	}{
		{name: "custom Fail", settle: func(c *Call) {
			data, _ := Map(KV("feed", mustPublicText("a")))
			c.Fail(&ScriptError{Code: "no feed", Message: "gone", Data: data})
		}, code: "no feed", result: NumberShape},
		{name: "nil Fail", settle: func(c *Call) { c.Fail(nil) }, code: "host error", detail: true, result: NumberShape},
		{name: "catalogue Fail", settle: func(c *Call) { c.Fail(&ScriptError{Code: "timeout"}) }, code: "host error", detail: true, result: NumberShape},
		{name: "reserved Fail", settle: func(c *Call) { data, _ := Map(KV("at", Int(9))); c.Fail(&ScriptError{Code: "no feed", Data: data}) }, code: "host error", detail: true, result: NumberShape},
		{name: "undeclared Fail", settle: func(c *Call) { c.Fail(&ScriptError{Code: "other"}) }, code: "host error", detail: true, result: NumberShape},
		{name: "bad result", settle: func(c *Call) { c.Answer(mustPublicText("bad")) }, code: "host error", detail: true, result: NumberShape},
		{name: "late Fuel", settle: func(c *Call) { c.AnswerWithCost(Int(9), 100) }, limits: Limits{FuelPerRun: 40}, limit: "fuel", result: NumberShape},
		{name: "late allocation atomic", settle: func(c *Call) { c.AnswerWithCost(Int(9), 5) }, limits: Limits{AllocPerRun: 15}, limit: "alloc", result: NumberShape},
		{name: "returned ScriptError", start: func(*Call, []Value) error { return &ScriptError{Code: "no feed"} }, code: "no feed", result: NumberShape},
		{name: "panic", start: func(*Call, []Value) error { panic("private detail") }, code: "host error", detail: true, result: NumberShape},
		{name: "swallowed Charge", start: func(c *Call, _ []Value) error { c.Charge(100); return nil }, limits: Limits{FuelPerRun: 40}, limit: "fuel", result: NumberShape},
	} {
		t.Run(test.name, func(t *testing.T) {
			g, s, calls, _ := suspendingLoad(t, Operation{Result: test.result, Start: test.start, Errors: []ErrorDecl{{Code: "no feed"}}}, "on go\nask api to fetch and wait\nreturn it\nend", test.limits)
			s.Deliver(Message{Name: "go"})
			first := joinPump(t, g, 0, PumpOptions{})
			r := first
			if test.settle != nil {
				test.settle((*calls)[0])
				r = joinPump(t, g, 1, PumpOptions{})
			}
			end := joinEnd(t, r, "s")
			if test.limit != "" {
				if end.Outcome != LimitFault || end.Limit != test.limit {
					t.Fatalf("%+v", end)
				}
				if test.name == "late allocation atomic" && r.FuelUsed != 0 {
					t.Fatalf("partially charged conversion %+v", r)
				}
			} else {
				if end.Outcome != Errored || end.Error == nil || end.Error.Code != test.code || end.At.Line != 2 {
					t.Fatalf("%+v", end)
				}
				got := false
				for _, report := range r.Reports {
					if _, ok := report.(*CallFailed); ok {
						got = true
					}
				}
				if got != test.detail {
					t.Fatalf("CallFailed=%v %+v", got, r)
				}
			}
		})
	}
}
func mustPublicText(s string) Value { v, _ := Text(s); return v }

func TestSuspendingOperationTimeoutAndCancellation(t *testing.T) {
	for _, cancel := range []bool{false, true} {
		t.Run(fmt.Sprint(cancel), func(t *testing.T) {
			g, s, calls, trace := suspendingLoad(t, Operation{Result: NumberShape, MaxPending: 2 * time.Second}, "script variable cleaned=0\non go\ntry\nask api to fetch and wait\nfinally\nput 1 into cleaned\nend try\nend go", Limits{MaxWait: time.Second})
			ready := make(chan struct{}, 2)
			g.options.OnReady = func() { ready <- struct{}{} }
			ctx, stop := context.WithCancel(context.Background())
			defer stop()
			_, _, e := s.Request(ctx, Message{Name: "go"})
			if e != nil {
				t.Fatal(e)
			}
			<-ready
			first := joinPump(t, g, 0, PumpOptions{})
			if !first.NextDeadline.Equal(time.Unix(2, 0)) {
				t.Fatal(first)
			}
			if cancel {
				stop()
				<-ready
			}
			end := joinEnd(t, joinPump(t, g, 2, PumpOptions{}), "s")
			if cancel {
				if end.Outcome != Cancelled {
					t.Fatal(end)
				}
			} else if end.Error == nil || end.Error.Code != "timeout" || end.Error.Data.String() != "{after: 2000 ms, capability: \"api\", operation: \"fetch\", at: {unit: \"s\", handler: \"go\", line: 4, column: 1}}" {
				t.Fatalf("%+v", end)
			}
			if (*calls)[0].Context().Err() == nil {
				t.Fatal("pending context not cancelled")
			}
			(*calls)[0].Answer(Int(9))
			<-ready
			joinPump(t, g, 3, PumpOptions{})
			if !strings.Contains(strings.Join(*trace, "\n"), "kind=late-answer") {
				t.Fatal(*trace)
			}
		})
	}
}

func TestCapabilityJoinUsesMemberDeadlinesAndFirstFailure(t *testing.T) {
	for _, timeout := range []bool{false, true} {
		t.Run(fmt.Sprint(timeout), func(t *testing.T) {
			g, s, calls, trace := suspendingLoad(t, Operation{Result: NumberShape, MaxPending: time.Second}, "on go\nwait for all\nsend ping to b and wait\nask api to fetch and wait\nask api to fetch and wait\nend wait\nend go", Limits{MaxWait: 3 * time.Second})
			joinLoad(t, g, "b", "on ping\nwait 2 s\nreturn 4\nend ping", Limits{})
			s.Deliver(Message{Name: "go"})
			first := joinPump(t, g, 0, PumpOptions{})
			if len(*calls) != 2 || !first.NextDeadline.Equal(time.Unix(1, 0)) {
				t.Fatal(first)
			}
			if !timeout {
				(*calls)[1].Fail(&ScriptError{Code: "no feed"})
				(*calls)[0].Answer(Int(9))
			}
			r := joinPump(t, g, 1, PumpOptions{FuelCap: 1})
			end := joinEnd(t, r, "s")
			code, index := "no feed", "3"
			if timeout {
				code, index = "timeout", "2"
			}
			if end.Error == nil || end.Error.Code != code || end.Error.Data.Get("index").String() != index || end.At.Line != 6 {
				t.Fatalf("%+v", end)
			}
			if (*calls)[0].Context().Err() == nil {
				t.Fatal("abandoned context alive")
			}
			if !timeout && !strings.Contains(strings.Join(*trace, "\n"), "note s/r1.c2 kind=late-answer") {
				t.Fatal(*trace)
			}
			if joinEnd(t, joinPump(t, g, 2, PumpOptions{}), "b").Outcome != Completed {
				t.Fatal("send receiver cancelled")
			}
		})
	}
}

func TestCapabilityJoinKeepsEarlySettlementsAcrossBodyPreemption(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(fmt.Sprint(fail), func(t *testing.T) {
			g, s, calls, _ := suspendingLoad(t, Operation{Result: NumberShape}, `script variable seen=nothing
on go
 try
  seed
  wait for all
   ask api to fetch and wait
   put it into seen
   ask api to fetch and wait
  end wait
  return it
 catch e
  return e
 end try
end go
on seed
 return 77
end seed`, Limits{})
			s.Deliver(Message{Name: "go"})
			first := joinPump(t, g, 0, PumpOptions{FuelCap: 40})
			if first.State != Sliced || len(*calls) != 1 || g.Inspect().Scripts[0].Runs[0].Status != Preempted {
				t.Fatal(first, *calls)
			}
			if fail {
				(*calls)[0].Fail(&ScriptError{Code: "gone"})
			} else {
				(*calls)[0].Answer(Int(1))
			}
			second := joinPump(t, g, 1, PumpOptions{FuelCap: 1})
			if len(second.Reports) != 0 || len(*calls) != 1 || g.Inspect().Scripts[0].Runs[0].Status != Preempted {
				t.Fatal(second)
			}
			third := joinPump(t, g, 1, PumpOptions{})
			if len(*calls) != 2 || g.Inspect().Scripts[0].Vars[0].Val.String() != "77" {
				t.Fatal(third, *calls)
			}
			if fail {
				end := joinEnd(t, third, "s")
				if end.Outcome != Completed || end.Result.Get("code").String() != "\"gone\"" || end.Result.Get("index").String() != "1" || (*calls)[1].Context().Err() == nil {
					t.Fatal(end)
				}
			} else {
				if len(third.Reports) != 0 {
					t.Fatal(third)
				}
				(*calls)[1].Answer(Int(2))
				end := joinEnd(t, joinPump(t, g, 2, PumpOptions{}), "s")
				if end.Result.String() != "[1, 2]" {
					t.Fatal(end)
				}
			}
		})
	}
}

func TestLateCapabilityFaultPreservesEarlierSegments(t *testing.T) {
	g, s, calls, _ := suspendingLoad(t, Operation{Result: NumberShape}, "script variable stage=0\non go\nput 1 into stage\nask api to fetch and wait\nput 2 into stage\nask api to fetch and wait\nput 3 into stage\nend go", Limits{FuelPerRun: 80})
	s.Deliver(Message{Name: "go"})
	joinPump(t, g, 0, PumpOptions{})
	if s.Counters().PersistentState == 0 || g.Inspect().Scripts[0].Vars[0].Val.String() != "1" {
		t.Fatal("first Segment not committed")
	}
	(*calls)[0].Answer(Int(9))
	joinPump(t, g, 1, PumpOptions{})
	if len(*calls) != 2 || g.Inspect().Scripts[0].Vars[0].Val.String() != "2" {
		t.Fatal("second Segment not committed")
	}
	(*calls)[1].AnswerWithCost(Int(9), 100)
	end := joinEnd(t, joinPump(t, g, 2, PumpOptions{}), "s")
	if end.Outcome != LimitFault || end.Limit != "fuel" || g.Inspect().Scripts[0].Vars[0].Val.String() != "2" || len(*calls) != 2 {
		t.Fatal(end)
	}
}

func TestCapabilityReadyAnswerRetentionAndCap(t *testing.T) {
	g, s, calls, _ := suspendingLoad(t, Operation{Result: NumberShape}, "on go\nask api to fetch and wait\nreturn it\nend\non other\nreturn 0\nend", Limits{})
	s.Deliver(Message{Name: "go"})
	joinPump(t, g, 0, PumpOptions{})
	if s.Counters().PersistentState != 224 {
		t.Fatal(s.Counters())
	}
	s.Deliver(Message{Name: "other"})
	(*calls)[0].AnswerWithCost(Int(9), 5)
	joinPump(t, g, 1, PumpOptions{FuelCap: 7})
	if s.Counters().PersistentState != 192 || g.Inspect().Scripts[0].Runs[0].Status != Ready {
		t.Fatal(s.Counters())
	}
	r := joinPump(t, g, 1, PumpOptions{FuelCap: 1})
	if r.FuelUsed != 6 || r.State != Sliced || len(r.Reports) != 0 || g.Inspect().Scripts[0].Runs[0].Status != Preempted {
		t.Fatal(r)
	}
	end := joinEnd(t, joinPump(t, g, 1, PumpOptions{}), "s")
	if end.Result.String() != "9" {
		t.Fatal(end)
	}
}

func TestCancelRunAtStartRollsBackAndAbandons(t *testing.T) {
	var s *Script
	g, loaded, calls, trace := suspendingLoad(t, Operation{Result: NumberShape, Start: func(c *Call, _ []Value) error { s.CancelRun(c.RunID()); c.Answer(Int(9)); return nil }}, "script variable stage=0\non go\ntry\nput 1 into stage\nask api to fetch and wait\nfinally\nput 2 into stage\nend try\nend go", Limits{})
	s = loaded
	s.Deliver(Message{Name: "go"})
	end := joinEnd(t, joinPump(t, g, 0, PumpOptions{}), "s")
	if end.Outcome != Cancelled || (*calls)[0].Context().Err() == nil || g.Inspect().Scripts[0].Vars[0].Val.String() != "2" {
		t.Fatal(end)
	}
	if strings.Contains(strings.Join(*trace, "\n"), "end=ask-wait") {
		t.Fatal("cancelled crossing committed a suspension", *trace)
	}
	joinPump(t, g, 1, PumpOptions{})
	if !strings.Contains(strings.Join(*trace, "\n"), "note s/r1.c1 kind=late-answer") {
		t.Fatal(*trace)
	}
}

func TestReloadChecksBeforeDiscardAndCarriesCommittedState(t *testing.T) {
	g, s, calls, trace := suspendingLoad(t, Operation{Result: NumberShape}, "script variable stage=0\non go\ntry\nput 1 into stage\nask api to fetch and wait\nfinally\nput 2 into stage\nend try\nend go", Limits{})
	_, p, e := s.Request(context.Background(), Message{Name: "go"})
	if e != nil {
		t.Fatal(e)
	}
	joinPump(t, g, 0, PumpOptions{})
	if _, e = s.Reload("on go\nask missing to fetch and wait\nend", CarryVariables); e == nil || (*calls)[0].Context().Err() != nil || len(g.Inspect().Scripts[0].Runs) != 1 {
		t.Fatal("rejected Reload changed live call")
	}
	reports, e := s.Reload("script variable stage=0\non go\nreturn stage\nend", CarryVariables)
	if e != nil || len(reports) != 1 || reports[0].(*Stop).PendingCalls[0] != (*calls)[0].ID() || (*calls)[0].Context().Err() == nil || g.Inspect().Scripts[0].Vars[0].Val.String() != "1" {
		t.Fatal(reports, e)
	}
	select {
	case <-p.Done():
	default:
		t.Fatal("discarded Request not settled")
	}
	_, failure := p.Result()
	if failure == nil || failure.Data.Get("reason").String() != "\"stopped\"" {
		t.Fatal(failure)
	}
	(*calls)[0].Answer(Int(9))
	s.Deliver(Message{Name: "go"})
	if joinEnd(t, joinPump(t, g, 1, PumpOptions{}), "s").Result.String() != "1" || !strings.Contains(strings.Join(*trace, "\n"), "kind=late-answer") {
		t.Fatal(*trace)
	}
}

func TestReloadCarriesPreemptedBaseAndStalesFunctions(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s := joinLoad(t, g, "s", "script variable n=0\nscript variable f=given: 1\non go\nput 2 into n\nrepeat forever\nput 3 into n\nend repeat\nend go", Limits{})
	s.Deliver(Message{Name: "go"})
	joinPump(t, g, 0, PumpOptions{FuelCap: 6})
	if g.Inspect().Scripts[0].Vars[0].Val.String() != "2" {
		t.Fatal("did not preempt after write")
	}
	_, e := s.Reload("script variable n=9\nscript variable f=nothing\non go\nreturn f()\nend", CarryVariables)
	if e != nil {
		t.Fatal(e)
	}
	if g.Inspect().Scripts[0].Vars[0].Val.String() != "0" {
		t.Fatal("carried provisional writes")
	}
	s.Deliver(Message{Name: "go"})
	end := joinEnd(t, joinPump(t, g, 1, PumpOptions{}), "s")
	if end.Error == nil || end.Error.Code != "function gone" {
		t.Fatal(end)
	}
}

func TestAbandonedCapabilityHandlesDoNotAccumulate(t *testing.T) {
	g, s, calls, _ := suspendingLoad(t, Operation{Result: NumberShape}, "on go\nrepeat 3 times\ntry\nwait for all\nask api to fetch and wait\nask api to fetch and wait\nend wait\ncatch e\nwait 0 s\nend try\nend repeat\nend go", Limits{})
	s.Deliver(Message{Name: "go"})
	joinPump(t, g, 0, PumpOptions{})
	for n := 0; n < 3; n++ {
		(*calls)[2*n+1].Fail(&ScriptError{Code: "gone"})
		joinPump(t, g, 0, PumpOptions{})
		if len(g.calls) != 0 || (*calls)[2*n].Context().Err() == nil {
			t.Fatalf("iteration %d retained %d handles", n, len(g.calls))
		}
		joinPump(t, g, 0, PumpOptions{})
	}
}

func TestSuspendingPrechargeAndRetentionFaults(t *testing.T) {
	for _, test := range []struct {
		name   string
		limits Limits
		cost   Cost
		args   []Shape
		input  Value
		join   bool
		want   string
		starts int
	}{
		{name: "arguments", args: []Shape{TextShape}, input: Int(1), want: "wrong kind"},
		{name: "declared allocation", cost: Cost{Fuel: 7, Alloc: 100}, limits: Limits{AllocPerRun: 15}, want: "alloc"},
		{name: "declared Fuel", cost: Cost{Fuel: 100}, limits: Limits{FuelPerRun: 40}, want: "fuel"},
		{name: "pending retention", limits: Limits{PersistentState: 200}, want: "persistent", starts: 1},
		{name: "Join width", join: true, limits: Limits{MaxJoin: 1}, want: "join", starts: 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			source := "on go\nask api to fetch and wait\nend"
			if test.args != nil {
				source = "on go x\nask api to fetch x and wait\nend"
			}
			if test.join {
				source = "on go\nwait for all\nask api to fetch and wait\nask api to fetch and wait\nend wait\nend"
			}
			g, s, calls, _ := suspendingLoad(t, Operation{Args: test.args, Result: NumberShape, Cost: test.cost}, source, test.limits)
			message := Message{Name: "go"}
			if test.args != nil {
				message.Args = []Value{test.input}
			}
			s.Deliver(message)
			r := joinPump(t, g, 0, PumpOptions{})
			end := joinEnd(t, r, "s")
			if len(*calls) != test.starts {
				t.Fatal("wrong Start count", len(*calls))
			}
			if test.want == "wrong kind" {
				if end.Error == nil || end.Error.Code != test.want {
					t.Fatal(end)
				}
			} else if end.Limit != test.want {
				t.Fatal(end)
			}
			if test.starts > 0 && (*calls)[0].Context().Err() == nil {
				t.Fatal("fault left a pending context")
			}
			if test.starts == 0 && test.want != "wrong kind" && r.FuelUsed != 0 {
				t.Fatal("non-atomic declared cost", r)
			}
		})
	}
}

func TestSuspendingResultOwnership(t *testing.T) {
	other := New().NewGroup(GroupOptions{})
	foreign := joinLoad(t, other, "foreign", "on go\nreturn given: 1\nend", Limits{})
	foreign.Deliver(Message{Name: "go"})
	fn := joinEnd(t, joinPump(t, other, 0, PumpOptions{}), "foreign").Result
	for _, fail := range []bool{false, true} {
		t.Run(fmt.Sprint(fail), func(t *testing.T) {
			g, s, calls, _ := suspendingLoad(t, Operation{Result: FunctionShape}, "on go\nask api to fetch and wait\nend", Limits{})
			s.Deliver(Message{Name: "go"})
			joinPump(t, g, 0, PumpOptions{})
			if fail {
				data, _ := Map(KV("fn", fn))
				(*calls)[0].Fail(&ScriptError{Code: "custom", Data: data})
			} else {
				(*calls)[0].Answer(fn)
			}
			end := joinEnd(t, joinPump(t, g, 1, PumpOptions{}), "s")
			if end.Error == nil || end.Error.Code != "host error" {
				t.Fatal(end)
			}
		})
	}
}

func TestReloadRecordsDiscardBeforeDecisionSettlement(t *testing.T) {
	var trace lines
	g := New().NewGroup(GroupOptions{Trace: &trace})
	s := joinLoad(t, g, "s", "on go, deciding\nrepeat forever\nend repeat\nend go", Limits{})
	_, decision, e := s.Decide(context.Background(), Message{Name: "go"})
	if e != nil {
		t.Fatal(e)
	}
	joinPump(t, g, 0, PumpOptions{FuelCap: 1})
	reports, e := s.Reload("on go\nend go", ResetVariables)
	if e != nil {
		t.Fatal(e)
	}
	if len(reports) != 2 {
		t.Fatal(reports)
	}
	if _, ok := reports[0].(*Stop); !ok {
		t.Fatal("Stop report must precede discarded Delivery settlement")
	}
	if decision.Decided() == nil || decision.Decided().Verdict != Undecided {
		t.Fatal("Decision not settled")
	}
	records := strings.Join(trace, "\n")
	stopped, decided := strings.Index(records, "stopped s"), strings.Index(records, "decided ")
	if stopped < 0 || decided < stopped || !strings.Contains(records, "stopped s reason=\"reload\" discarded=[s/r1]") {
		t.Fatal(records)
	}
}
