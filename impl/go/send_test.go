package northtalk

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestSendToLaterLoadedScriptIsFIFOAndKeepsSender(t *testing.T) {
	var trace lines
	g := New().NewGroup(GroupOptions{Trace: &trace})
	a, err := g.Load(LoadOptions{Name: "a", Source: `on go
 send ping with 7 to b
 send ping with 8 to b
end go`})
	if err != nil {
		t.Fatal(err)
	}
	_, err = g.Load(LoadOptions{Name: "b", Source: `script variable seen = []
on ping n
 put n after seen
end ping`})
	if err != nil {
		t.Fatal(err)
	}
	a.Deliver(Message{Name: "go"})
	result, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Reports) != 3 {
		t.Fatalf("want sender and two receiver Runs: %+v", result)
	}
	sender := result.Reports[0].(*RunEnd)
	if sender.Outcome != Completed || sender.Fuel != 55 || sender.Alloc != 96 {
		t.Fatal(sender)
	}
	if got := g.Inspect().Scripts[1].Vars[0].Val.String(); got != "[7, 8]" {
		t.Fatal(got)
	}
	records := strings.Join(trace, "\n")
	for _, line := range []string{`send a/r1 to=b message=ping args=[7]`, `send a/r1 to=b message=ping args=[8]`, `seg b/r1 start from=a/r1 handler=ping clause=1`} {
		if !strings.Contains(records, line) {
			t.Fatalf("missing %s\n%s", line, records)
		}
	}
}

func TestSendToMeUsesMailboxAndLeavesItUnchanged(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: `script variable seen = []
on go
 let keep be 9
 send ping to me
 put [keep, it] after seen
end go
on ping
 put "ping" after seen
end ping`})
	if err != nil {
		t.Fatal(err)
	}
	s.Deliver(Message{Name: "go"})
	result, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil || len(result.Reports) != 2 {
		t.Fatalf("%+v %v", result, err)
	}
	if got := g.Inspect().Scripts[0].Vars[0].Val.String(); got != `[[9, nothing], "ping"]` {
		t.Fatal(got)
	}
}

func TestSelfSendCountsMailboxAtPersistentBoundaries(t *testing.T) {
	for _, tc := range []struct {
		tail  string
		limit int64
	}{
		{"return", 100},
		{"wait 1 s", 400},
	} {
		t.Run(tc.tail, func(t *testing.T) {
			g := New().NewGroup(GroupOptions{})
			s, err := g.Load(LoadOptions{Name: "s", Limits: Limits{PersistentState: tc.limit}, Source: "on go\n send ping with \"" + strings.Repeat("x", 200) + "\" to me\n " + tc.tail + "\nend go\non ping x\n return\nend ping"})
			if err != nil {
				t.Fatal(err)
			}
			s.Deliver(Message{Name: "go"})
			result, err := g.Pump(time.Unix(0, 0), PumpOptions{})
			if err != nil || len(result.Reports) != 2 {
				t.Fatalf("%+v %v", result, err)
			}
			sender := result.Reports[0].(*RunEnd)
			if sender.Outcome != LimitFault || sender.Limit != "persistent" {
				t.Fatal(sender)
			}
			if result.Reports[1].(*RunEnd).Outcome != Completed {
				t.Fatal("sent message did not survive sender fault", result)
			}
		})
	}
}

func TestSendBudgetFaultDoesNotDeliver(t *testing.T) {
	for _, limits := range []Limits{{FuelPerRun: 6}, {AllocPerRun: 1}} {
		g := New().NewGroup(GroupOptions{})
		a, err := g.Load(LoadOptions{Name: "a", Limits: limits, Source: "on go\n send ping with 7 to b\nend go"})
		if err != nil {
			t.Fatal(err)
		}
		_, err = g.Load(LoadOptions{Name: "b", Source: "on ping n\n return n\nend ping"})
		if err != nil {
			t.Fatal(err)
		}
		a.Deliver(Message{Name: "go"})
		result, err := g.Pump(time.Unix(0, 0), PumpOptions{})
		if err != nil || len(result.Reports) != 1 {
			t.Fatalf("%+v %v", result, err)
		}
		end := result.Reports[0].(*RunEnd)
		if end.Outcome != LimitFault || end.Fuel != 6 || end.Alloc != 0 {
			t.Fatal(end)
		}
		if g.Inspect().Scripts[1].Runs != nil {
			t.Fatal("budget fault delivered message")
		}
	}
}

func TestFullMailboxSendIsChargedAndCatchable(t *testing.T) {
	var trace lines
	g := New().NewGroup(GroupOptions{Trace: &trace})
	a, err := g.Load(LoadOptions{Name: "a", Source: `script variable failure = nothing
on go
 try
  send ping with 7 to b
 catch e
  put e into failure
 end try
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
	result, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil || len(result.Reports) != 2 {
		t.Fatalf("%+v %v", result, err)
	}
	end := result.Reports[0].(*RunEnd)
	if end.Outcome != Completed || end.Alloc != 48 {
		t.Fatal(end)
	}
	failure := g.Inspect().Scripts[0].Vars[0].Val
	if failure.Get("code").String() != `"mailbox full"` || failure.Get("to").String() != `"b"` || failure.Get("at").Get("line").String() != "4" {
		t.Fatal(failure)
	}
	if strings.Contains(strings.Join(trace, "\n"), "send a/r1") {
		t.Fatal(trace)
	}
}

func TestNamedReceiverSurvivesPreemptionWithoutValueSize(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	a, err := g.Load(LoadOptions{Name: "a", Source: "on go\n send ping with 7 to b\nend go"})
	if err != nil {
		t.Fatal(err)
	}
	b, err := g.Load(LoadOptions{Name: "b", Source: "on ping n\n return n\nend ping"})
	if err != nil {
		t.Fatal(err)
	}
	a.Deliver(Message{Name: "go"})
	first, err := g.Pump(time.Unix(0, 0), PumpOptions{FuelSlice: 6})
	if err != nil || first.State != Sliced || first.FuelUsed != 6 {
		t.Fatalf("%+v %v", first, err)
	}
	if got := a.Counters().PersistentState; got != 192 {
		t.Fatalf("receiver Name is not a Value: state=%d, want192", got)
	}
	if b.Counters().Runs != 0 {
		t.Fatal("receiver ran before send")
	}
	result, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil || len(result.Reports) != 2 {
		t.Fatalf("%+v %v", result, err)
	}
	if result.Reports[1].(*RunEnd).Result.String() != "7" {
		t.Fatal(result)
	}
}

func TestCommittedSendSurvivesSenderError(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	a, err := g.Load(LoadOptions{Name: "a", Source: "on go\n send ping with 7 to b\n throw \"bad\"\nend go"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = g.Load(LoadOptions{Name: "b", Source: "on ping n\n return n\nend ping"})
	if err != nil {
		t.Fatal(err)
	}
	a.Deliver(Message{Name: "go"})
	result, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil || len(result.Reports) != 2 {
		t.Fatalf("%+v %v", result, err)
	}
	if result.Reports[0].(*RunEnd).Outcome != Errored || result.Reports[1].(*RunEnd).Result.String() != "7" {
		t.Fatal(result)
	}
}

func TestMultipleReceiverNamesOnStackHaveNoValueSize(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: `on watch
 wait for
 when ping from a then return
 when pong from b then return
 end wait
end watch`})
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"a", "b"} {
		if _, err = g.Load(LoadOptions{Name: name, Source: "on ping\n return\nend ping"}); err != nil {
			t.Fatal(err)
		}
	}
	s.Deliver(Message{Name: "watch"})
	result, err := g.Pump(time.Unix(0, 0), PumpOptions{FuelSlice: 6})
	if err != nil || result.FuelUsed != 6 {
		t.Fatalf("%+v %v", result, err)
	}
	if got := s.Counters().PersistentState; got != 192 {
		t.Fatalf("two receiver Names are not Values: state=%d, want192", got)
	}
}

func TestSendCountsHostReservationsAcceptedDuringPump(t *testing.T) {
	var trace lines
	g := New().NewGroup(GroupOptions{Trace: &trace})
	a, err := g.Load(LoadOptions{Name: "a", Source: "on go\n send ping with 7 to b\n send ping with 8 to b\nend go"})
	if err != nil {
		t.Fatal(err)
	}
	b, err := g.Load(LoadOptions{Name: "b", Limits: Limits{MailboxDepth: 2}, Source: "on ping n\n return n\nend ping"})
	if err != nil {
		t.Fatal(err)
	}
	var inputError error
	g.options.Trace = traceFunc(func(line string) {
		trace.Record(line)
		if line == `send a/r1 to=b message=ping args=[7]` {
			_, inputError = b.Deliver(Message{Name: "ping", Args: []Value{Int(99)}})
		}
	})
	a.Deliver(Message{Name: "go"})
	result, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil || inputError != nil || len(result.Reports) != 2 {
		t.Fatalf("%+v %v %v", result, err, inputError)
	}
	if result.Reports[0].(*RunEnd).Error.Code != "mailbox full" || result.Reports[1].(*RunEnd).Result.String() != "7" {
		t.Fatal(result)
	}
	result, err = g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil || len(result.Reports) != 1 || result.Reports[0].(*RunEnd).Result.String() != "99" {
		t.Fatalf("%+v %v", result, err)
	}
	if _, err = b.Deliver(Message{Name: "ping"}); err != nil {
		t.Fatal("reservation leaked", err)
	}
}

func TestSentRunUsesReceiverLimits(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	a, err := g.Load(LoadOptions{Name: "a", Source: "on go\n send ping with 7 to b\nend go"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = g.Load(LoadOptions{Name: "b", Limits: Limits{FuelPerRun: 5}, Source: "on ping n\n return n\nend ping"})
	if err != nil {
		t.Fatal(err)
	}
	a.Deliver(Message{Name: "go", Limits: &LimitOverride{FuelPerRun: 40}})
	result, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil || len(result.Reports) != 2 {
		t.Fatalf("%+v %v", result, err)
	}
	if result.Reports[0].(*RunEnd).Outcome != Completed {
		t.Fatal(result)
	}
	receiver := result.Reports[1].(*RunEnd)
	if receiver.Outcome != LimitFault || receiver.Limit != "fuel" || receiver.Fuel != 5 {
		t.Fatal(receiver)
	}
}

func TestSendAndWaitRemainsAtUntouchedBoundary(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	a, err := g.Load(LoadOptions{Name: "a", Source: "on go\n send ping with 7 to b and wait\nend go"})
	if err != nil {
		t.Fatal(err)
	}
	b, err := g.Load(LoadOptions{Name: "b", Source: "on ping n\n return n\nend ping"})
	if err != nil {
		t.Fatal(err)
	}
	a.Deliver(Message{Name: "go"})
	result, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil || len(result.Reports) != 0 || result.FuelUsed != 6 {
		t.Fatalf("%+v %v", result, err)
	}
	if b.Counters().Runs != 0 || a.Counters().AllocTotal != 0 {
		t.Fatal("deferred send delivered or charged")
	}
}

func TestCancellingSenderPreservesSentRunAndCanSendFromCleanup(t *testing.T) {
	ready := make(chan struct{}, 2)
	g := New().NewGroup(GroupOptions{OnReady: func() { ready <- struct{}{} }})
	a, err := g.Load(LoadOptions{Name: "a", Source: `on go
 try
  send ping to b
  wait 10 s
 finally
  send cleanup to b
 end try
end go`})
	if err != nil {
		t.Fatal(err)
	}
	_, err = g.Load(LoadOptions{Name: "b", Source: `script variable seen = []
on ping
 wait 0 s
 put "ping" after seen
end ping
on cleanup
 put "cleanup" after seen
end cleanup`})
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
	result, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil || len(result.Reports) != 3 {
		t.Fatalf("%+v %v", result, err)
	}
	_, failure := pending.Result()
	if failure == nil || failure.Data.Get("reason").String() != `"cancelled"` {
		t.Fatal(failure)
	}
	if got := g.Inspect().Scripts[1].Vars[0].Val.String(); got != `["ping", "cleanup"]` {
		t.Fatal(got)
	}
}
