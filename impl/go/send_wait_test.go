package northtalk

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestSendWaitRetainsCallThenReplyWithoutExtraCharge(t *testing.T) {
	var trace lines
	g := New().NewGroup(GroupOptions{Trace: &trace})
	a, err := g.Load(LoadOptions{Name: "a", Source: "on go\n send ping with 7 to b and wait\n return it\nend go"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = g.Load(LoadOptions{Name: "b", Source: "on ping n\n return n\nend ping"})
	if err != nil {
		t.Fatal(err)
	}
	a.Deliver(Message{Name: "go"})
	now := time.Unix(0, 0)
	first, err := g.Pump(now, PumpOptions{FuelCap: 28})
	if err != nil || len(operationalReports(first.Reports)) != 0 || first.FuelUsed != 28 {
		t.Fatalf("%+v %v", first, err)
	}
	view := g.Inspect().Scripts[0].Runs
	if len(view) != 1 || view[0].Status != Suspended || view[0].Wait != "send-wait" || !view[0].Until.IsZero() || len(view[0].Calls) != 1 || view[0].Calls[0] != "a/r1.c1" {
		t.Fatal(view)
	}
	if got := a.Counters().PersistentState; got != 224 {
		t.Fatalf("pending call state %d, want224", got)
	}
	second, err := g.Pump(now, PumpOptions{FuelCap: 7})
	if err != nil || len(operationalReports(second.Reports)) != 1 {
		t.Fatalf("%+v %v", second, err)
	}
	if got := a.Counters().PersistentState; got != 192 {
		t.Fatalf("ready reply state %d, want192", got)
	}
	last, err := g.Pump(now, PumpOptions{})
	if err != nil || len(operationalReports(last.Reports)) != 1 {
		t.Fatalf("%+v %v", last, err)
	}
	end := operationalReports(last.Reports)[0].(*RunEnd)
	if end.Outcome != Completed || end.Result.String() != "7" || end.Fuel != 32 || end.Alloc != 48 {
		t.Fatal(end)
	}
	if !strings.Contains(strings.Join(trace, "\n"), "send a/r1.c1 to=b message=ping args=[7] wait=yes") {
		t.Fatal(trace)
	}
}

func TestSendWaitTimeoutLeavesReceiverRunning(t *testing.T) {
	var trace lines
	g := New().NewGroup(GroupOptions{Trace: &trace})
	a, err := g.Load(LoadOptions{Name: "a", Limits: Limits{MaxWait: time.Minute}, Source: `script variable failure = nothing
on go
 try
  send ping to b and wait
 catch e
  put e into failure
 end try
end go`})
	if err != nil {
		t.Fatal(err)
	}
	_, err = g.Load(LoadOptions{Name: "b", Source: "on ping\n wait 2 s\n return 9\nend ping"})
	if err != nil {
		t.Fatal(err)
	}
	a.Deliver(Message{Name: "go", Limits: &LimitOverride{MaxWait: time.Second}})
	first, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil || !first.NextDeadline.Equal(time.Unix(1, 0)) {
		t.Fatalf("%+v %v", first, err)
	}
	second, err := g.Pump(time.Unix(1, 0), PumpOptions{})
	if err != nil || len(operationalReports(second.Reports)) != 1 {
		t.Fatalf("%+v %v", second, err)
	}
	failure := g.Inspect().Scripts[0].Vars[0].Val
	if failure.Get("code").String() != `"timeout"` || failure.Get("after").String() != "1000 ms" || failure.Get("at").Get("line").String() != "4" {
		t.Fatal(failure)
	}
	last, err := g.Pump(time.Unix(2, 0), PumpOptions{})
	if err != nil || len(operationalReports(last.Reports)) != 1 || operationalReports(last.Reports)[0].(*RunEnd).Result.String() != "9" {
		t.Fatalf("%+v %v", last, err)
	}
	records := strings.Join(trace, "\n")
	if !strings.Contains(records, "abandon a/r1.c1") || strings.Index(records, `raise a/r1 code="timeout"`) > strings.Index(records, "abandon a/r1.c1") {
		t.Fatal(records)
	}
}

func TestCancellingSendWaitDropsReplyAndRunsCleanup(t *testing.T) {
	ready := make(chan struct{}, 2)
	var trace lines
	g := New().NewGroup(GroupOptions{Trace: &trace, OnReady: func() { ready <- struct{}{} }})
	a, err := g.Load(LoadOptions{Name: "a", Source: `script variable cleaned = false
on go
 try
  send ping to b and wait
 finally
  put true into cleaned
 end try
end go`})
	if err != nil {
		t.Fatal(err)
	}
	_, err = g.Load(LoadOptions{Name: "b", Source: "on ping\n wait 2 s\n return 9\nend ping"})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	_, pending, err := a.Request(ctx, Message{Name: "go"})
	if err != nil {
		t.Fatal(err)
	}
	<-ready
	if _, err = g.Pump(time.Unix(0, 0), PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	cancel()
	select {
	case <-ready:
	case <-time.After(time.Second):
		t.Fatal("cancellation not queued")
	}
	r, err := g.Pump(time.Unix(1, 0), PumpOptions{})
	if err != nil || len(operationalReports(r.Reports)) != 1 || operationalReports(r.Reports)[0].(*RunEnd).Outcome != Cancelled {
		t.Fatalf("%+v %v", r, err)
	}
	if _, failure := pending.Result(); failure == nil || failure.Data.Get("reason").String() != `"cancelled"` {
		t.Fatal(failure)
	}
	if got := g.Inspect().Scripts[0].Vars[0].Val.String(); got != "true" {
		t.Fatal(got)
	}
	r, err = g.Pump(time.Unix(2, 0), PumpOptions{})
	if err != nil || len(operationalReports(r.Reports)) != 1 || operationalReports(r.Reports)[0].(*RunEnd).Result.String() != "9" {
		t.Fatalf("%+v %v", r, err)
	}
	if strings.Count(strings.Join(trace, "\n"), "abandon a/r1.c1") != 1 {
		t.Fatal(trace)
	}
}

func TestSendWaitFailureUnwindSpendsPumpCapBeforeCatch(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	a, err := g.Load(LoadOptions{Name: "a", Source: `on go
 try
  query and wait
 catch {code: "send failed", reason: why}
  return why
 end try
end go
on query
 send ping to b and wait
end query`})
	if err != nil {
		t.Fatal(err)
	}
	_, err = g.Load(LoadOptions{Name: "b", Source: "on ping\n wait 0 s\n throw \"bad\"\nend ping"})
	if err != nil {
		t.Fatal(err)
	}
	a.Deliver(Message{Name: "go"})
	now := time.Unix(0, 0)
	if _, err = g.Pump(now, PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, err = g.Pump(now, PumpOptions{FuelCap: 15}); err != nil {
		t.Fatal(err)
	}
	r, err := g.Pump(now, PumpOptions{FuelCap: 1})
	if err != nil || len(operationalReports(r.Reports)) != 0 || r.FuelUsed != 4 || r.State != Sliced {
		t.Fatalf("%+v %v", r, err)
	}
	r, err = g.Pump(now, PumpOptions{})
	if err != nil || len(operationalReports(r.Reports)) != 1 || operationalReports(r.Reports)[0].(*RunEnd).Result.String() != `"errored"` {
		t.Fatalf("%+v %v", r, err)
	}
}

func TestSendWaitUsesSelfMailboxAndIncreasingCallIDs(t *testing.T) {
	var trace lines
	g := New().NewGroup(GroupOptions{Trace: &trace})
	s, err := g.Load(LoadOptions{Name: "s", Source: `on go
 send ping with 7 to me and wait
 send ping with it + 1 to me and wait
 return it
end go
on ping n
 return n
end ping`})
	if err != nil {
		t.Fatal(err)
	}
	s.Deliver(Message{Name: "go"})
	r, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil || len(operationalReports(r.Reports)) != 3 || operationalReports(r.Reports)[2].(*RunEnd).Result.String() != "8" {
		t.Fatalf("%+v %v", r, err)
	}
	records := strings.Join(trace, "\n")
	for _, line := range []string{"send s/r1.c1 to=s message=ping args=[7] wait=yes", "send s/r1.c2 to=s message=ping args=[8] wait=yes"} {
		if !strings.Contains(records, line) {
			t.Fatal(records)
		}
	}
}

func TestSendWaitPendingStateFaultAbandonsOnlyTheReply(t *testing.T) {
	var trace lines
	g := New().NewGroup(GroupOptions{Trace: &trace})
	a, err := g.Load(LoadOptions{Name: "a", Limits: Limits{PersistentState: 223}, Source: "on go\n send ping with 7 to b and wait\nend go"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = g.Load(LoadOptions{Name: "b", Source: "on ping n\n return n\nend ping"})
	if err != nil {
		t.Fatal(err)
	}
	a.Deliver(Message{Name: "go"})
	r, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil || len(operationalReports(r.Reports)) != 2 || !r.NextDeadline.IsZero() {
		t.Fatalf("%+v %v", r, err)
	}
	sender := operationalReports(r.Reports)[0].(*RunEnd)
	if sender.Outcome != LimitFault || sender.Limit != "persistent" || sender.Fuel != 28 || sender.Alloc != 48 || operationalReports(r.Reports)[1].(*RunEnd).Result.String() != "7" {
		t.Fatal(r)
	}
	if strings.Count(strings.Join(trace, "\n"), "abandon a/r1.c1") != 1 {
		t.Fatal(trace)
	}
}

func TestSendWaitBudgetFaultDoesNotRegisterOrSend(t *testing.T) {
	for _, limit := range []Limits{{FuelPerRun: 6}, {AllocPerRun: 1}} {
		var trace lines
		g := New().NewGroup(GroupOptions{Trace: &trace})
		a, err := g.Load(LoadOptions{Name: "a", Limits: limit, Source: "on go\n send ping with 7 to b and wait\nend go"})
		if err != nil {
			t.Fatal(err)
		}
		b, err := g.Load(LoadOptions{Name: "b", Source: "on ping n\n return n\nend ping"})
		if err != nil {
			t.Fatal(err)
		}
		a.Deliver(Message{Name: "go"})
		r, err := g.Pump(time.Unix(0, 0), PumpOptions{})
		if err != nil || len(operationalReports(r.Reports)) != 1 || operationalReports(r.Reports)[0].(*RunEnd).Outcome != LimitFault || r.FuelUsed != 6 || !r.NextDeadline.IsZero() {
			t.Fatalf("%+v %v", r, err)
		}
		records := strings.Join(trace, "\n")
		if b.Counters().Runs != 0 || strings.Contains(records, "send a/r1") || strings.Contains(records, "abandon a/r1") {
			t.Fatal(records)
		}
	}
}

func TestSendWaitReceiverFaultAndDroppingReasons(t *testing.T) {
	for _, tc := range []struct {
		reason, source string
		limits         Limits
		busy           bool
	}{
		{"limit fault", "on ping\n return 7\nend ping", Limits{FuelPerRun: 5}, false},
		{"dropped", "on ping, dropping\n wait 2 s\nend ping", Limits{}, true},
	} {
		t.Run(tc.reason, func(t *testing.T) {
			g := New().NewGroup(GroupOptions{})
			a, err := g.Load(LoadOptions{Name: "a", Source: `on go
 try
  send ping to b and wait
 catch {code: "send failed", reason: why}
  return why
 end try
end go`})
			if err != nil {
				t.Fatal(err)
			}
			b, err := g.Load(LoadOptions{Name: "b", Source: tc.source, Limits: tc.limits})
			if err != nil {
				t.Fatal(err)
			}
			a.Deliver(Message{Name: "go"})
			if tc.busy {
				b.Deliver(Message{Name: "ping"})
			}
			r, err := g.Pump(time.Unix(0, 0), PumpOptions{})
			if err != nil {
				t.Fatal(err)
			}
			found := false
			for _, report := range operationalReports(r.Reports) {
				if end, ok := report.(*RunEnd); ok && end.Script == "a" {
					if end.Outcome != Completed || end.Result.String() != `"`+tc.reason+`"` {
						t.Fatal(end)
					}
					found = true
				}
			}
			if !found {
				t.Fatal(r)
			}
		})
	}
}

func TestSendWaitReceiverReplacementRaisesCancelled(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	a, err := g.Load(LoadOptions{Name: "a", Source: `on go
 try
  send ping to b and wait
 catch {code: "send failed", reason: why}
  return why
 end try
end go`})
	if err != nil {
		t.Fatal(err)
	}
	b, err := g.Load(LoadOptions{Name: "b", Source: "on ping, replacing\n wait 2 s\n return 7\nend ping"})
	if err != nil {
		t.Fatal(err)
	}
	a.Deliver(Message{Name: "go"})
	if _, err = g.Pump(time.Unix(0, 0), PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	b.Deliver(Message{Name: "ping"})
	r, err := g.Pump(time.Unix(1, 0), PumpOptions{})
	if err != nil || len(operationalReports(r.Reports)) != 2 {
		t.Fatalf("%+v %v", r, err)
	}
	if got := operationalReports(r.Reports)[1].(*RunEnd); got.Script != "a" || got.Outcome != Completed || got.Result.String() != `"cancelled"` {
		t.Fatal(got)
	}
}

func TestFullMailboxWaitIsChargedAndDoesNotConsumeCallID(t *testing.T) {
	var trace lines
	g := New().NewGroup(GroupOptions{Trace: &trace})
	a, err := g.Load(LoadOptions{Name: "a", Source: `on go
 try
  send ping with 7 to b and wait
 catch {code: "mailbox full"}
  wait 0 s
 end try
 send ping with 8 to b and wait
 return it
end go`})
	if err != nil {
		t.Fatal(err)
	}
	b, err := g.Load(LoadOptions{Name: "b", Limits: Limits{MailboxDepth: 1}, Source: "on ping n\n return n\nend ping"})
	if err != nil {
		t.Fatal(err)
	}
	a.Deliver(Message{Name: "go"})
	b.Deliver(Message{Name: "ping", Args: []Value{Int(0)}})
	if _, err = g.Pump(time.Unix(0, 0), PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	r, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil || len(operationalReports(r.Reports)) != 2 || operationalReports(r.Reports)[1].(*RunEnd).Result.String() != "8" || operationalReports(r.Reports)[1].(*RunEnd).Alloc != 96 {
		t.Fatalf("%+v %v", r, err)
	}
	records := strings.Join(trace, "\n")
	if !strings.Contains(records, "send a/r1.c1 to=b message=ping args=[8] wait=yes") || strings.Contains(records, "a/r1.c2") {
		t.Fatal(records)
	}
}
