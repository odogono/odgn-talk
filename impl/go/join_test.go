package northtalk

import (
	"strings"
	"testing"
	"time"
)

func TestScriptJoinReturnsRepliesInStartOrder(t *testing.T) {
	var trace lines
	g := New().NewGroup(GroupOptions{Trace: &trace})
	a := joinLoad(t, g, "a", `script variable first = nothing
script variable second = nothing
on go
 seed
 wait for all
  send ping with 7 to b and wait
  put it into first
  send ping with 9 to c and wait
  put it into second
 end wait
 return it
end go
on seed
 return 91
end seed`, Limits{})
	joinLoad(t, g, "b", "on ping n\n wait 2 s\n return n\nend ping", Limits{})
	joinLoad(t, g, "c", "on ping n\n wait 0 s\n return n\nend ping", Limits{})
	a.Deliver(Message{Name: "go"})
	joinPump(t, g, 0, PumpOptions{})
	runs := g.Inspect().Scripts[0].Runs
	if len(runs) != 1 || runs[0].Status != Suspended || runs[0].Wait != "join-end" || !runs[0].Until.IsZero() || len(runs[0].Calls) != 2 || runs[0].Calls[0] != "a/r1.c1" || runs[0].Calls[1] != "a/r1.c2" {
		t.Fatal(runs)
	}
	for _, v := range g.Inspect().Scripts[0].Vars {
		if v.Val.String() != "91" {
			t.Fatal(v)
		}
	}
	joinPump(t, g, 0, PumpOptions{})
	end := joinEnd(t, joinPump(t, g, 2, PumpOptions{}), "a")
	if end.Outcome != Completed || end.Result.String() != "[7, 9]" {
		t.Fatal(end)
	}
	records := strings.Join(trace, "\n")
	for _, record := range []string{"send a/r1.c1 to=b message=ping args=[7] wait=join", "send a/r1.c2 to=c message=ping args=[9] wait=join"} {
		if !strings.Contains(records, record) {
			t.Fatal(records)
		}
	}
}
func joinLoad(t *testing.T, g *Group, name, source string, limits Limits) *Script {
	t.Helper()
	s, err := g.Load(LoadOptions{Name: name, Source: source, Limits: limits})
	if err != nil {
		t.Fatal(err)
	}
	return s
}
func joinPump(t *testing.T, g *Group, second int64, opts PumpOptions) PumpResult {
	t.Helper()
	r, err := g.Pump(time.Unix(second, 0), opts)
	if err != nil {
		t.Fatal(err)
	}
	return r
}
func joinEnd(t *testing.T, r PumpResult, script string) *RunEnd {
	t.Helper()
	for _, report := range r.Reports {
		if end, ok := report.(*RunEnd); ok && end.Script == script {
			return end
		}
	}
	t.Fatalf("no %s end in %+v", script, r)
	return nil
}
func TestScriptJoinWithNoDynamicMembersDoesNotSuspend(t *testing.T) {
	var trace lines
	g := New().NewGroup(GroupOptions{Trace: &trace})
	s := joinLoad(t, g, "s", `on go
 wait for all
  if false then
   send ping to me and wait
  end if
 end wait
 return it
end go
on ping
 return 7
end ping`, Limits{})
	s.Deliver(Message{Name: "go"})
	end := joinEnd(t, joinPump(t, g, 0, PumpOptions{}), "s")
	if end.Outcome != Completed || end.Result.String() != "[]" || end.Alloc != 16 {
		t.Fatal(end)
	}
	records := strings.Join(trace, "\n")
	if strings.Count(records, "seg s/r1 ") != 1 || strings.Contains(records, "end=join-end") || strings.Contains(records, "send s/r1") {
		t.Fatal(records)
	}
}
func TestScriptJoinRetainsEarlyAnswersUntilOrderedResult(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	a := joinLoad(t, g, "a", `on go
 wait for all
  send ping with 7 to b and wait
  send ping with 9 to c and wait
 end wait
 return it
end go`, Limits{})
	joinLoad(t, g, "b", "on ping n\n wait 0 s\n return n\nend ping", Limits{})
	joinLoad(t, g, "c", "on ping n\n wait 2 s\n return n\nend ping", Limits{})
	a.Deliver(Message{Name: "go"})
	joinPump(t, g, 0, PumpOptions{})
	pending := a.Counters().PersistentState
	joinPump(t, g, 0, PumpOptions{FuelCap: 3})
	if got := a.Counters().PersistentState; got != pending-32 {
		t.Fatalf("early answer state %d, pending state %d: replacing a 48-byte call with a 16-byte answer should release 32", got, pending)
	}
	calls := g.Inspect().Scripts[0].Runs[0].Calls
	if len(calls) != 1 || calls[0] != "a/r1.c2" {
		t.Fatal(calls)
	}
	joinPump(t, g, 2, PumpOptions{FuelCap: 3})
	if got := a.Counters().PersistentState; got != pending-64 {
		t.Fatalf("all ready answer state %d, pending state %d", got, pending)
	}
	end := joinEnd(t, joinPump(t, g, 2, PumpOptions{}), "a")
	if end.Outcome != Completed || end.Result.String() != "[7, 9]" || end.Alloc != 160 {
		t.Fatal(end)
	}
}

func TestScriptJoinFailureUsesClosingEndAndAbandonsPendingOnly(t *testing.T) {
	var trace lines
	g := New().NewGroup(GroupOptions{Trace: &trace})
	a := joinLoad(t, g, "a", `script variable failure = nothing
on go
 try
  wait for all
   send ping to b and wait
   send ping to c and wait
  end wait
 catch e
  put e into failure
 end try
end go`, Limits{})
	joinLoad(t, g, "b", "on ping\n wait 2 s\n return 7\nend ping", Limits{})
	joinLoad(t, g, "c", "on ping\n throw \"bad\"\nend ping", Limits{})
	a.Deliver(Message{Name: "go"})
	end := joinEnd(t, joinPump(t, g, 0, PumpOptions{}), "a")
	if end.Outcome != Completed {
		t.Fatal(end)
	}
	failure := g.Inspect().Scripts[0].Vars[0].Val
	if failure.Get("code").String() != `"send failed"` || failure.Get("reason").String() != `"errored"` || failure.Get("index").String() != "2" || failure.Get("at").Get("line").String() != "4" || failure.Get("error").Get("code").String() != `"bad"` {
		t.Fatal(failure)
	}
	records := strings.Join(trace, "\n")
	// The join-end PC is normative; current lowerers retain the head source span.
	if !strings.Contains(records, `raise a/r1 code="send failed" at=a:9 pos=4:3`) {
		t.Fatal(records)
	}
	if strings.Count(records, "abandon a/r1.c1") != 1 || strings.Contains(records, "abandon a/r1.c2") || strings.Index(records, `raise a/r1 code="send failed"`) > strings.Index(records, "abandon a/r1.c1") {
		t.Fatal(records)
	}
	if end := joinEnd(t, joinPump(t, g, 2, PumpOptions{}), "b"); end.Result.String() != "7" {
		t.Fatal(end)
	}
}

func TestScriptJoinBodyFailureAbandonsAcceptedMembers(t *testing.T) {
	for _, tc := range []struct {
		name, body, code string
		full             bool
	}{
		{"throw", "throw \"bad\"", "bad", false},
		{"full mailbox", "send ping to c and wait", "mailbox full", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var trace lines
			g := New().NewGroup(GroupOptions{Trace: &trace})
			a := joinLoad(t, g, "a", "on go\n try\n  wait for all\n   send ping to b and wait\n   "+tc.body+"\n  end wait\n catch e\n  return e\n end try\nend go", Limits{})
			joinLoad(t, g, "b", "on ping\n return 7\nend ping", Limits{})
			c := joinLoad(t, g, "c", "on ping\n return 9\nend ping", Limits{MailboxDepth: 1})
			a.Deliver(Message{Name: "go"})
			if tc.full {
				c.Deliver(Message{Name: "ping"})
			}
			r := joinPump(t, g, 0, PumpOptions{})
			end := joinEnd(t, r, "a")
			if end.Outcome != Completed || end.Result.Get("code").String() != `"`+tc.code+`"` || end.Result.Get("at").Get("line").String() != "5" || end.Result.Get("index").String() != "nothing" {
				t.Fatal(end)
			}
			if receiver := joinEnd(t, r, "b"); receiver.Result.String() != "7" {
				t.Fatal(receiver)
			}
			records := strings.Join(trace, "\n")
			if strings.Count(records, "abandon a/r1.c1") != 1 || strings.Contains(records, "send a/r1.c2") || strings.Index(records, "raise a/r1 ") > strings.Index(records, "abandon a/r1.c1") {
				t.Fatal(records)
			}
		})
	}
}

func TestScriptJoinMaxJoinChecksBeforeMemberCharge(t *testing.T) {
	var trace lines
	g := New().NewGroup(GroupOptions{Trace: &trace})
	a := joinLoad(t, g, "a", `on go
 wait for all
  send ping to b and wait
  send ping to b and wait
 end wait
end go`, Limits{MaxJoin: 2, FuelPerRun: 38})
	joinLoad(t, g, "b", "on ping\n return 7\nend ping", Limits{})
	a.Deliver(Message{Name: "go", Limits: &LimitOverride{MaxJoin: 1}})
	r := joinPump(t, g, 0, PumpOptions{})
	end := joinEnd(t, r, "a")
	if end.Outcome != LimitFault || end.Limit != "join" || end.At.Line != 4 || end.Fuel != 37 || end.Alloc != 32 {
		t.Fatal(end)
	}
	if receiver := joinEnd(t, r, "b"); receiver.Result.String() != "7" {
		t.Fatal(receiver)
	}
	records := strings.Join(trace, "\n")
	if strings.Count(records, "send a/r1.c1") != 1 || strings.Contains(records, "send a/r1.c2") || strings.Count(records, "abandon a/r1.c1") != 1 {
		t.Fatal(records)
	}
}

func TestScriptJoinMemberAnswerDoesNotResetRemainingMaxWait(t *testing.T) {
	var trace lines
	g := New().NewGroup(GroupOptions{Trace: &trace})
	a := joinLoad(t, g, "a", `on go
 try
  wait for all
   send ping to b and wait
   send ping to c and wait
  end wait
 catch e
  return e
 end try
end go`, Limits{MaxWait: time.Minute})
	joinLoad(t, g, "b", "on ping\n wait 1 s\n return 7\nend ping", Limits{})
	joinLoad(t, g, "c", "on ping\n wait 3 s\n return 9\nend ping", Limits{})
	a.Deliver(Message{Name: "go", Limits: &LimitOverride{MaxWait: 2 * time.Second}})
	first := joinPump(t, g, 0, PumpOptions{})
	if !first.NextDeadline.Equal(time.Unix(1, 0)) {
		t.Fatal(first)
	}
	second := joinPump(t, g, 1, PumpOptions{})
	if !second.NextDeadline.Equal(time.Unix(2, 0)) {
		t.Fatal(second)
	}
	end := joinEnd(t, joinPump(t, g, 2, PumpOptions{}), "a")
	if end.Outcome != Completed || end.Result.Get("code").String() != `"timeout"` || end.Result.Get("index").String() != "2" || end.Result.Get("after").String() != "2000 ms" || end.Result.Get("at").Get("line").String() != "3" {
		t.Fatal(end)
	}
	records := strings.Join(trace, "\n")
	if !strings.Contains(records, `raise a/r1 code="timeout" at=a:7 pos=3:3`) {
		t.Fatal(records)
	}
	if strings.Contains(records, "abandon a/r1.c1") || strings.Count(records, "abandon a/r1.c2") != 1 {
		t.Fatal(records)
	}
	if receiver := joinEnd(t, joinPump(t, g, 3, PumpOptions{}), "c"); receiver.Result.String() != "9" {
		t.Fatal(receiver)
	}
}

func TestScriptJoinSelfSendsRespectQueuedClause(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s := joinLoad(t, g, "s", `on go
 wait for all
  send ping with 7 to me and wait
  send ping with 9 to me and wait
 end wait
 return it
end go
on ping n, queued
 wait 1 s
 return n
end ping`, Limits{})
	s.Deliver(Message{Name: "go"})
	joinPump(t, g, 0, PumpOptions{})
	first := joinPump(t, g, 1, PumpOptions{})
	if len(first.Reports) != 1 || first.Reports[0].(*RunEnd).Result.String() != "7" || !first.NextDeadline.Equal(time.Unix(2, 0)) {
		t.Fatal(first)
	}
	last := joinPump(t, g, 2, PumpOptions{})
	if len(last.Reports) != 2 {
		t.Fatal(last)
	}
	end := last.Reports[1].(*RunEnd)
	if end.Handler != "go" || end.Outcome != Completed || end.Result.String() != "[7, 9]" {
		t.Fatal(end)
	}
}
func TestScriptJoinPendingStateFaultPreservesBothReceivers(t *testing.T) {
	var trace lines
	g := New().NewGroup(GroupOptions{Trace: &trace})
	a := joinLoad(t, g, "a", `on go
 wait for all
  send ping with 7 to b and wait
  send ping with 9 to c and wait
 end wait
end go`, Limits{PersistentState: 271})
	joinLoad(t, g, "b", "on ping n\n return n\nend ping", Limits{})
	joinLoad(t, g, "c", "on ping n\n return n\nend ping", Limits{})
	a.Deliver(Message{Name: "go"})
	r := joinPump(t, g, 0, PumpOptions{})
	end := joinEnd(t, r, "a")
	if end.Outcome != LimitFault || end.Limit != "persistent" || end.Alloc != 96 {
		t.Fatal(end)
	}
	if joinEnd(t, r, "b").Result.String() != "7" || joinEnd(t, r, "c").Result.String() != "9" || !r.NextDeadline.IsZero() {
		t.Fatal(r)
	}
	records := strings.Join(trace, "\n")
	if strings.Count(records, "abandon a/r1.c1") != 1 || strings.Count(records, "abandon a/r1.c2") != 1 {
		t.Fatal(records)
	}
}

func TestScriptJoinRetainsReplyDuringPreemptedBody(t *testing.T) {
	var trace lines
	g := New().NewGroup(GroupOptions{Trace: &trace})
	a := joinLoad(t, g, "a", `on go
 put 0 into n
 wait for all
  send ping with 7 to b and wait
  repeat 10 times
   put n + 1 into n
  end repeat
  send ping with 9 to b and wait
 end wait
 return it
end go`, Limits{})
	joinLoad(t, g, "b", "on ping n\n return n\nend ping", Limits{})
	a.Deliver(Message{Name: "go"})
	first := joinPump(t, g, 0, PumpOptions{FuelSlice: 40})
	if receiver := joinEnd(t, first, "b"); receiver.Result.String() != "7" {
		t.Fatal(receiver)
	}
	if strings.Contains(strings.Join(trace, "\n"), "end=join-end") {
		t.Fatal(trace)
	}
	for i := 0; i < 30; i++ {
		r := joinPump(t, g, 0, PumpOptions{FuelSlice: 40})
		for _, report := range r.Reports {
			if end, ok := report.(*RunEnd); ok && end.Script == "a" {
				if end.Outcome != Completed || end.Result.String() != "[7, 9]" {
					t.Fatal(end)
				}
				return
			}
		}
	}
	t.Fatal("caller did not collect the reply received before closing the Join")
}

func TestScriptJoinReplacementAbandonsMembersAndRunsCleanup(t *testing.T) {
	var trace lines
	g := New().NewGroup(GroupOptions{Trace: &trace})
	a := joinLoad(t, g, "a", `script variable cleaned = 0
on go n, replacing
 try
  wait for all
   send ping with n to b and wait
   send ping with n to c and wait
  end wait
  return it
 finally
  put cleaned + 1 into cleaned
 end try
end go`, Limits{})
	joinLoad(t, g, "b", "on ping n\n wait 2 s\n return n\nend ping", Limits{})
	joinLoad(t, g, "c", "on ping n\n wait 2 s\n return n\nend ping", Limits{})
	a.Deliver(Message{Name: "go", Args: []Value{Int(1)}})
	joinPump(t, g, 0, PumpOptions{})
	a.Deliver(Message{Name: "go", Args: []Value{Int(2)}})
	cancelled := joinEnd(t, joinPump(t, g, 1, PumpOptions{}), "a")
	if cancelled.Run != "a/r1" || cancelled.Outcome != Cancelled || g.Inspect().Scripts[0].Vars[0].Val.String() != "1" {
		t.Fatal(cancelled)
	}
	late := joinPump(t, g, 2, PumpOptions{})
	if len(late.Reports) != 2 {
		t.Fatal(late)
	}
	for _, report := range late.Reports {
		if report.(*RunEnd).Script == "a" {
			t.Fatal(report)
		}
	}
	end := joinEnd(t, joinPump(t, g, 3, PumpOptions{}), "a")
	if end.Run != "a/r2" || end.Outcome != Completed || end.Result.String() != "[2, 2]" || g.Inspect().Scripts[0].Vars[0].Val.String() != "2" {
		t.Fatal(end)
	}
	records := strings.Join(trace, "\n")
	if strings.Count(records, "abandon a/r1.c1") != 1 || strings.Count(records, "abandon a/r1.c2") != 1 || strings.Contains(records, "abandon a/r2.") {
		t.Fatal(records)
	}
}
