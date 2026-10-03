package northtalk

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestWaitReleasesScriptAndResumesAfterInputs(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: `script variable seen = []
on nap n
 put n after seen
 wait 0 s
 put n + 10 after seen
end nap
on mark
 put 99 after seen
end mark
`})
	if err != nil {
		t.Fatal(err)
	}
	for _, n := range []int64{1, 2} {
		if _, err := s.Deliver(Message{Name: "nap", Args: []Value{Int(n)}}); err != nil {
			t.Fatal(err)
		}
	}
	now := time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC)
	r, err := g.Pump(now, PumpOptions{})
	if err != nil || r.State != Idle || len(r.Reports) != 0 || !r.NextDeadline.Equal(now) {
		t.Fatal(r, err)
	}
	view := g.Inspect().Scripts[0]
	if view.Vars[0].Val.String() != "[1, 2]" || len(view.Runs) != 2 {
		t.Fatal(view)
	}
	for j, run := range view.Runs {
		if run.ID != RunID([]string{"s/r1", "s/r2"}[j]) || run.Status != Suspended || run.Wait != "wait" || !run.Until.Equal(now) {
			t.Fatal(run)
		}
	}
	if c := s.Counters(); c.MailboxLen != 0 || c.Runs != 2 || c.PersistentState <= 2*176 {
		t.Fatal(c)
	}
	if _, err := s.Deliver(Message{Name: "mark"}); err != nil {
		t.Fatal(err)
	}
	r, err = g.Pump(now, PumpOptions{FuelCap: 1})
	if err != nil || r.State != Sliced || !r.NextDeadline.IsZero() || len(r.Reports) != 0 {
		t.Fatal(r, err)
	}
	view = g.Inspect().Scripts[0]
	if len(view.Runs) != 3 || view.Runs[0].Status != Ready || view.Runs[1].Status != Ready || view.Runs[2].Status != Preempted {
		t.Fatal(view)
	}
	if view.Runs[0].Wait != "" || !view.Runs[0].Until.IsZero() || len(view.Mailbox) != 0 {
		t.Fatal(view)
	}
	r, err = g.Pump(now, PumpOptions{})
	if err != nil || r.State != Idle || !r.NextDeadline.IsZero() || len(r.Reports) != 3 {
		t.Fatal(r, err)
	}
	if got := g.Inspect().Scripts[0]; got.Vars[0].Val.String() != "[1, 2, 99, 11, 12]" || len(got.Runs) != 0 {
		t.Fatal(got)
	}
}

func TestWaitCancellationKeepsCommittedSegmentAndRunsFinally(t *testing.T) {
	var trace lines
	g := New().NewGroup(GroupOptions{Trace: &trace})
	s, err := g.Load(LoadOptions{Name: "s", Source: `script variable a = 0
script variable b = 0
on nap
 try
  put 1 into a
  wait 1 s
  put 99 into a
 finally
  put b + 1 into b
 end try
end nap
on mark
 put 7 into a
end mark
`})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	_, pending, err := s.Request(ctx, Message{Name: "nap"})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC)
	if r, err := g.Pump(now, PumpOptions{}); err != nil || len(r.Reports) != 0 {
		t.Fatal(r, err)
	}
	select {
	case <-pending.Done():
		t.Fatal("suspended Request settled")
	default:
	}
	s.Deliver(Message{Name: "mark"})
	g.Pump(now, PumpOptions{})
	// Queue synchronously: context cancellation uses this same input path.
	g.cancelDelivery(delivery{id: "d1", script: s, pending: pending})
	r, err := g.Pump(now.Add(time.Second), PumpOptions{})
	if err != nil || len(r.Reports) != 1 || r.Reports[0].(*RunEnd).Outcome != Cancelled || !r.NextDeadline.IsZero() {
		t.Fatal(r, err)
	}
	view := g.Inspect().Scripts[0]
	if view.Vars[0].Val.String() != "7" || view.Vars[1].Val.String() != "1" || len(view.Runs) != 0 {
		t.Fatal(view)
	}
	select {
	case <-pending.Done():
	default:
		t.Fatal("cancelled Request unsettled")
	}
	if !strings.Contains(strings.Join(trace, "\n"), "seg s/r1 resume") {
		t.Fatal(trace)
	}
}

func TestWaitCancellationCleanupRollbackStartsAtItsTurn(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Limits: Limits{CleanupBudget: 1}, Source: `script variable a = 0
on nap
 try
  put 1 into a
  wait 1 s
 finally
  put 2 into a
 end try
end nap
on mark
 put 7 into a
end mark
`})
	if err != nil {
		t.Fatal(err)
	}
	id, p, err := s.Request(nil, Message{Name: "nap"})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC)
	g.Pump(now, PumpOptions{})
	s.Deliver(Message{Name: "mark"})
	g.cancelDelivery(delivery{id: id, script: s, pending: p})
	r, err := g.Pump(now, PumpOptions{})
	if err != nil || len(r.Reports) != 2 {
		t.Fatal(r, err)
	}
	end := r.Reports[1].(*RunEnd)
	if end.CleanupFailed == nil || end.CleanupFailed.Limit != "cleanup" {
		t.Fatal(end)
	}
	if got := g.Inspect().Scripts[0].Vars[0].Val.String(); got != "7" {
		t.Fatalf("cleanup rollback undid earlier queued Run: %s", got)
	}
}

func TestWaitCancellationQueuesCleanupInInputOrder(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: `script variable seen = []
on nap
 try
  wait 1 s
 finally
  put "cleanup" after seen
 end try
end nap
on mark
 put "mark" after seen
end mark
`})
	if err != nil {
		t.Fatal(err)
	}
	id, p, err := s.Request(nil, Message{Name: "nap"})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC)
	g.Pump(now, PumpOptions{})
	g.cancelDelivery(delivery{id: id, script: s, pending: p})
	s.Deliver(Message{Name: "mark"})
	g.Pump(now, PumpOptions{})
	if got := g.Inspect().Scripts[0].Vars[0].Val.String(); got != `["cleanup", "mark"]` {
		t.Fatal(got)
	}
}

func TestDeferredHandlerPoliciesKeepRequestsPending(t *testing.T) {
	for _, policy := range []string{"queued", "dropping", "replacing", "deciding"} {
		t.Run(policy, func(t *testing.T) {
			g := New().NewGroup(GroupOptions{})
			s, err := g.Load(LoadOptions{Name: "s", Source: "on work, " + policy + "\n return 7\nend work\n"})
			if err != nil {
				t.Fatal(err)
			}
			_, p, err := s.Request(nil, Message{Name: "work"})
			if err != nil {
				t.Fatal(err)
			}
			r, err := g.Pump(time.Unix(0, 0), PumpOptions{})
			if err != nil || r.FuelUsed != 0 || len(r.Reports) != 0 {
				t.Fatal(r, err)
			}
			select {
			case <-p.Done():
				t.Fatal("unsupported policy settled Request")
			default:
			}
		})
	}
}

func TestWaitFuelFaultDoesNotChargeOrInstallTimer(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Limits: Limits{FuelPerRun: 14}, Source: "on nap\n wait 1 s\nend nap\n"})
	if err != nil {
		t.Fatal(err)
	}
	_, p, err := s.Request(nil, Message{Name: "nap"})
	if err != nil {
		t.Fatal(err)
	}
	r, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil || len(r.Reports) != 1 || r.FuelUsed != 5 || !r.NextDeadline.IsZero() {
		t.Fatal(r, err)
	}
	end := r.Reports[0].(*RunEnd)
	if end.Outcome != LimitFault || end.Limit != "fuel" || end.At.Line != 2 {
		t.Fatal(end)
	}
	select {
	case <-p.Done():
	default:
		t.Fatal("faulted Request unsettled")
	}
	if len(g.Inspect().Scripts[0].Runs) != 0 {
		t.Fatal("faulted wait retained")
	}
}

func TestWaitBeyondNativeDeadlineRangeDefersWithoutOverflow(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: "on nap\n wait 1000000000000000000000000000000000 s\nend nap\n"})
	if err != nil {
		t.Fatal(err)
	}
	_, p, err := s.Request(nil, Message{Name: "nap"})
	if err != nil {
		t.Fatal(err)
	}
	r, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil || r.FuelUsed != 5 || len(r.Reports) != 0 || !r.NextDeadline.IsZero() {
		t.Fatal(r, err)
	}
	select {
	case <-p.Done():
		t.Fatal("deferred wait settled Request")
	default:
	}
	if got := g.Inspect().Scripts[0].Runs; len(got) != 1 || got[0].Status != Ready {
		t.Fatal(got)
	}
}

func TestWaitSliceOverrunCarriesDebtAcrossTimerReadiness(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: "on nap\n wait 0 s\nend nap\non mark\n return 7\nend mark\n"})
	if err != nil {
		t.Fatal(err)
	}
	s.Deliver(Message{Name: "nap"})
	s.Deliver(Message{Name: "mark"})
	now := time.Unix(0, 0)
	for j, fuel := range []int64{15, 0, 5} {
		r, err := g.Pump(now, PumpOptions{FuelSlice: 6})
		if err != nil || r.State != Sliced || r.FuelUsed != fuel || len(r.Reports) != 0 {
			t.Fatalf("Pump %d: %+v %v", j+1, r, err)
		}
		if j == 0 && !r.NextDeadline.Equal(now) || j > 0 && !r.NextDeadline.IsZero() {
			t.Fatal(r.NextDeadline)
		}
	}
	r, err := g.Pump(now, PumpOptions{})
	if err != nil || r.State != Idle || r.FuelUsed != 5 || len(r.Reports) != 2 {
		t.Fatal(r, err)
	}
	if r.Reports[0].(*RunEnd).Run != "s/r2" || r.Reports[1].(*RunEnd).Run != "s/r1" || s.Counters().FuelTotal != 25 {
		t.Fatal(r)
	}
}
