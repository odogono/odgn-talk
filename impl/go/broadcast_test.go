package northtalk

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestBroadcastSelectsRecipientsAtDrain(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	_, err := g.Load(LoadOptions{Name: "uninterested", Source: "on other\n return\nend other\n"})
	if err != nil {
		t.Fatal(err)
	}
	id, err := g.Broadcast(Message{Name: "go"})
	if err != nil || id != "b1" {
		t.Fatal(id, err)
	}
	s, err := g.Load(LoadOptions{Name: "late", Source: "on go\n pass go\nend go\n"})
	if err != nil {
		t.Fatal(err)
	}
	r, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil || len(r.Reports) != 1 {
		t.Fatal(r, err)
	}
	end := r.Reports[0].(*RunEnd)
	if end.Broadcast != id || end.Script != "late" || end.Delivery != "d1" || s.Counters().Runs != 1 || g.Script("uninterested").Counters().Runs != 0 {
		t.Fatal(end)
	}
}

func TestBroadcastDecisionReportsVetoesInRecipientOrderAcrossSlices(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	for _, o := range []LoadOptions{
		{Name: "slow", Source: "on go, deciding\n put 1 into x\n put 2 into x\n put 3 into x\n veto \"first\"\nend go\n"},
		{Name: "fast", Source: "on go, deciding\n veto \"second\"\nend go\n"},
	} {
		if _, err := g.Load(o); err != nil {
			t.Fatal(err)
		}
	}
	_, d, err := g.DecideBroadcast(nil, Message{Name: "go"})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Unix(0, 0)
	r, err := g.Pump(now, PumpOptions{FuelSlice: 10})
	if err != nil || r.State != Sliced || d.Decided() != nil || g.Script("fast").Counters().Runs != 1 {
		t.Fatal(r, err, d.Decided())
	}
	r, err = g.Pump(now, PumpOptions{})
	answer := d.Decided()
	if err != nil || answer == nil || answer.Verdict != Vetoed || len(answer.Vetoes) != 2 || answer.Vetoes[0].Script != "slow" || answer.Vetoes[1].Script != "fast" {
		t.Fatal(r, err, answer)
	}
	answer.Vetoes[0].Script = "mutated"
	if d.Decided().Vetoes[0].Script != "slow" {
		t.Fatal("future exposes report slices")
	}
}

func TestBroadcastDecisionCancellationRemovesEveryQueuedRecipient(t *testing.T) {
	ready := make(chan struct{}, 4)
	g := New().NewGroup(GroupOptions{OnReady: func() { ready <- struct{}{} }})
	for _, name := range []string{"a", "b"} {
		if _, err := g.Load(LoadOptions{Name: name, Source: "on go, deciding\n veto\nend go\n"}); err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	id, d, err := g.DecideBroadcast(ctx, Message{Name: "go"})
	if err != nil {
		t.Fatal(err)
	}
	<-ready
	cancel()
	<-ready
	r, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	answer := d.Decided()
	if err != nil || r.FuelUsed != 0 || len(r.Reports) != 3 || answer == nil || answer.Broadcast != id || answer.Verdict != Undecided || len(answer.Undecided) != 2 {
		t.Fatal(r, answer, err)
	}
	for i, name := range []string{"a", "b"} {
		if answer.Undecided[i].Script != name || answer.Undecided[i].Outcome != Cancelled || g.Script(name).Counters().Runs != 0 {
			t.Fatal(answer)
		}
		if _, err := g.Script(name).Deliver(Message{Name: "go"}); err != nil {
			t.Fatal(err)
		}
	}
}

func TestBroadcastCancellationPreservesSealedRecipientRun(t *testing.T) {
	ready := make(chan struct{}, 4)
	g := New().NewGroup(GroupOptions{OnReady: func() { ready <- struct{}{} }})
	for _, o := range []LoadOptions{
		{Name: "sealed", Source: "on go, deciding\n wait 1 s\n return 5\nend go\n"},
		{Name: "open", Source: "on go, deciding\n put 1 into x\n put 2 into x\n put 3 into x\n veto\nend go\n"},
	} {
		if _, err := g.Load(o); err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	_, d, err := g.DecideBroadcast(ctx, Message{Name: "go"})
	if err != nil {
		t.Fatal(err)
	}
	<-ready
	now := time.Unix(0, 0)
	if _, err := g.Pump(now, PumpOptions{FuelSlice: 10}); err != nil {
		t.Fatal(err)
	}
	if d.Decided() != nil {
		t.Fatal(d.Decided())
	}
	cancel()
	<-ready
	if _, err := g.Pump(now, PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	answer := d.Decided()
	if answer == nil || answer.Verdict != Undecided || len(answer.Undecided) != 1 || answer.Undecided[0].Script != "open" || len(g.Inspect().Scripts[0].Runs) != 1 {
		t.Fatal(answer, g.Inspect())
	}
	r, err := g.Pump(now.Add(time.Second), PumpOptions{})
	if err != nil || len(r.Reports) != 1 || r.Reports[0].(*RunEnd).Script != "sealed" || r.Reports[0].(*RunEnd).Outcome != Completed {
		t.Fatal(r, err)
	}
}

func TestBroadcastAcceptedPastMailboxCapacity(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Limits: Limits{MailboxDepth: 1}, Source: "on go\n return\nend go\n"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Deliver(Message{Name: "go"}); err != nil {
		t.Fatal(err)
	}
	if _, err := g.Broadcast(Message{Name: "go"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Deliver(Message{Name: "go"}); err != ErrMailboxFull {
		t.Fatal(err)
	}
	r, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil || len(r.Reports) != 2 || s.Counters().Runs != 2 || r.Reports[1].(*RunEnd).Broadcast != "b1" {
		t.Fatal(r, err)
	}
}

func TestBroadcastOverridesUseDefaultAdmissionAndTighterRecipientLimit(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	if _, err := g.Broadcast(Message{Name: "absent", Limits: &LimitOverride{FuelPerRun: DefaultLimits().FuelPerRun + 1}}); err == nil {
		t.Fatal("accepted loose override")
	}
	if _, err := g.Load(LoadOptions{Name: "s", Limits: Limits{FuelPerRun: 5}, Source: "on go, deciding\n return 7\nend go\n"}); err != nil {
		t.Fatal(err)
	}
	limits := &LimitOverride{FuelPerRun: 50}
	id, d, err := g.DecideBroadcast(nil, Message{Name: "go", Limits: limits})
	if err != nil || id != "b1" {
		t.Fatal(id, err)
	}
	limits.FuelPerRun = 1000000
	r, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil || d.Decided() == nil || d.Decided().Verdict != Undecided || d.Decided().Undecided[0].Outcome != LimitFault || r.Reports[0].(*RunEnd).Fuel > 5 {
		t.Fatal(r, err, d.Decided())
	}
}

func TestBroadcastPendingWaitAndPriorCancellation(t *testing.T) {
	for _, cancel := range []bool{false, true} {
		t.Run(map[bool]string{false: "waiting", true: "cancelled"}[cancel], func(t *testing.T) {
			var trace lines
			g := New().NewGroup(GroupOptions{Trace: &trace})
			s, err := g.Load(LoadOptions{Name: "s", Source: "on watch\n wait for go\n return\nend watch\n"})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := s.Deliver(Message{Name: "watch"}); err != nil {
				t.Fatal(err)
			}
			now := time.Unix(0, 0)
			if _, err := g.Pump(now, PumpOptions{}); err != nil {
				t.Fatal(err)
			}
			if cancel {
				s.CancelRun("s/r1")
			}
			if _, err := g.Broadcast(Message{Name: "go"}); err != nil {
				t.Fatal(err)
			}
			if _, err := g.Pump(now, PumpOptions{}); err != nil {
				t.Fatal(err)
			}
			want := int64(2)
			if cancel {
				want = 1
			}
			if s.Counters().Runs != want || strings.Contains("\n"+strings.Join(trace, "\n"), "\nunhandled ") {
				t.Fatal(trace, s.Counters())
			}
		})
	}
}

func TestBroadcastDecisionEmptySettlesAtPump(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	id, future, err := g.DecideBroadcast(context.Background(), Message{Name: "absent"})
	if err != nil || id != "b1" || future.Decided() != nil {
		t.Fatal(id, future, err)
	}
	r, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil || len(r.Reports) != 1 {
		t.Fatal(r, err)
	}
	d := future.Decided()
	if d == nil || d.Broadcast != id || d.Delivery != "" || d.Verdict != Allowed || r.FuelUsed != 0 {
		t.Fatal(d, r)
	}
}

func TestBroadcastTargetsRecipientOwnerWithoutClimbing(t *testing.T) {
	c := New()
	g := c.NewGroup(GroupOptions{})
	k := objectKindForTest(t, c, "room")
	parent, _ := g.Object(k, "parent", nil)
	child, _ := g.Object(k, "child", parent)
	if _, err := g.Load(LoadOptions{Name: "parent", Owner: parent, Source: "on other\n return\nend other\n"}); err != nil {
		t.Fatal(err)
	}
	if _, err := g.Load(LoadOptions{Name: "child", Owner: child, Source: "script variable seen = nothing\non go\n put the target into seen\n pass go\nend go\n"}); err != nil {
		t.Fatal(err)
	}
	if _, err := g.Broadcast(Message{Name: "go"}); err != nil {
		t.Fatal(err)
	}
	r, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil || len(r.Reports) != 1 || !g.Inspect().Scripts[1].Vars[0].Val.Equal(child.Value()) || g.Script("parent").Counters().Runs != 0 {
		t.Fatal(r, err, g.Inspect())
	}
}

func TestBroadcastDisposalOrder(t *testing.T) {
	for _, disposeFirst := range []bool{true, false} {
		t.Run(map[bool]string{true: "dispose first", false: "broadcast first"}[disposeFirst], func(t *testing.T) {
			c := New()
			g := c.NewGroup(GroupOptions{})
			o, _ := g.Object(objectKindForTest(t, c, "room"), "s", nil)
			if _, err := g.Load(LoadOptions{Name: "s", Owner: o, Source: "on go, deciding\n veto\nend go\n"}); err != nil {
				t.Fatal(err)
			}
			if disposeFirst {
				if err := g.Dispose(o); err != nil {
					t.Fatal(err)
				}
			}
			_, d, err := g.DecideBroadcast(nil, Message{Name: "go"})
			if err != nil {
				t.Fatal(err)
			}
			if !disposeFirst {
				if err := g.Dispose(o); err != nil {
					t.Fatal(err)
				}
			}
			r, err := g.Pump(time.Unix(0, 0), PumpOptions{})
			want := Allowed
			if !disposeFirst {
				want = Undecided
			}
			if err != nil || d.Decided() == nil || d.Decided().Verdict != want || g.Script("s").Counters().Runs != 0 {
				t.Fatal(r, err, d.Decided())
			}
		})
	}
}

func TestBroadcastDecisionReloadSealsOnlyDiscardedRecipient(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	source := "on go, deciding\n put 1 into x\n put 2 into x\n veto\nend go\n"
	for _, name := range []string{"a", "b"} {
		if _, err := g.Load(LoadOptions{Name: name, Source: source}); err != nil {
			t.Fatal(err)
		}
	}
	_, d, err := g.DecideBroadcast(nil, Message{Name: "go"})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Unix(0, 0)
	if _, err := g.Pump(now, PumpOptions{FuelSlice: 5}); err != nil {
		t.Fatal(err)
	}
	if _, err := g.Script("a").Reload(source, ResetVariables); err != nil {
		t.Fatal(err)
	}
	if d.Decided() != nil {
		t.Fatal("Reload sealed other recipient", d.Decided())
	}
	if _, err := g.Pump(now, PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	answer := d.Decided()
	if answer == nil || answer.Verdict != Vetoed || len(answer.Vetoes) != 1 || answer.Vetoes[0].Script != "b" || len(answer.Undecided) != 1 || answer.Undecided[0].Script != "a" {
		t.Fatal(answer)
	}
}

func TestBroadcastCopiesInputsAndValidatesGroup(t *testing.T) {
	c := New()
	g := c.NewGroup(GroupOptions{})
	other := c.NewGroup(GroupOptions{})
	o, _ := other.Object(objectKindForTest(t, c, "room"), "foreign", nil)
	if _, err := g.Broadcast(Message{Name: "go", Args: []Value{o.Value()}}); err == nil {
		t.Fatal("accepted foreign Object")
	}
	args := []Value{Int(7)}
	limits := &LimitOverride{FuelPerRun: 100}
	id, err := g.Broadcast(Message{Name: "go", Args: args, Limits: limits})
	if err != nil || id != "b1" {
		t.Fatal(id, err)
	}
	args[0] = Int(9)
	limits.FuelPerRun = 1
	if _, err := g.Load(LoadOptions{Name: "late", Source: "on go x\n return x\nend go\n"}); err != nil {
		t.Fatal(err)
	}
	r, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil || len(r.Reports) != 1 || !r.Reports[0].(*RunEnd).Result.Equal(Int(7)) {
		t.Fatal(r, err)
	}
}

func TestBroadcastDuringPumpWaitsForNextDrain(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: "on go\n return\nend go\n"})
	if err != nil {
		t.Fatal(err)
	}
	queued := false
	g.options.Trace = traceFunc(func(line string) {
		if !queued && strings.HasPrefix(line, "seg ") {
			queued = true
			if _, err := g.Broadcast(Message{Name: "go"}); err != nil {
				t.Error(err)
			}
		}
	})
	if _, err := s.Deliver(Message{Name: "go"}); err != nil {
		t.Fatal(err)
	}
	now := time.Unix(0, 0)
	if _, err := g.Pump(now, PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	if s.Counters().Runs != 1 {
		t.Fatal("Broadcast drained during Pump")
	}
	r, err := g.Pump(now, PumpOptions{})
	if err != nil || len(r.Reports) != 1 || r.Reports[0].(*RunEnd).Broadcast != "b1" {
		t.Fatal(r, err)
	}
}

func TestConcurrentBroadcastAdmission(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: "on go\n return\nend go\n"})
	if err != nil {
		t.Fatal(err)
	}
	var callers sync.WaitGroup
	ids := make(chan BroadcastID, 20)
	for range 20 {
		callers.Go(func() {
			id, err := g.Broadcast(Message{Name: "go"})
			if err != nil {
				t.Error(err)
			}
			ids <- id
		})
	}
	callers.Wait()
	close(ids)
	seen := map[BroadcastID]bool{}
	for id := range ids {
		if id == "" || seen[id] {
			t.Fatal(id)
		}
		seen[id] = true
	}
	r, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil || len(r.Reports) != 20 || s.Counters().Runs != 20 {
		t.Fatal(r, err)
	}
}
