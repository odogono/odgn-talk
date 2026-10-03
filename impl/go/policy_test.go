package northtalk

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestReplacingRunMustPayCombinedDispatchCharge(t *testing.T) {
	for _, budget := range []int64{4, 5} {
		t.Run(fmt.Sprint(budget), func(t *testing.T) {
			g := New().NewGroup(GroupOptions{})
			s, err := g.Load(LoadOptions{Name: "s", Source: "on work, replacing\n wait 1 s\nend work\n"})
			if err != nil {
				t.Fatal(err)
			}
			now := time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC)
			s.Deliver(Message{Name: "work"})
			g.Pump(now, PumpOptions{})
			s.Deliver(Message{Name: "work", Limits: &LimitOverride{FuelPerRun: budget}})
			r, err := g.Pump(now, PumpOptions{})
			if err != nil {
				t.Fatal(err)
			}
			wantFuel := int64(0)
			if budget == 5 {
				wantFuel = 5
			}
			if end := r.Reports[0].(*RunEnd); end.Outcome != LimitFault || end.Fuel != wantFuel {
				t.Fatal(end)
			}
			if budget == 4 {
				v := g.Inspect().Scripts[0]
				if len(r.Reports) != 1 || len(v.Runs) != 1 || v.Runs[0].ID != "s/r1" || v.Runs[0].Status != Suspended {
					t.Fatal(r, v)
				}
			} else if len(r.Reports) != 2 || r.Reports[1].(*RunEnd).Outcome != Cancelled {
				t.Fatal(r)
			}
		})
	}
}

func TestQueuedRunsParkFIFOAndDoNotBlockOtherClauses(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: `script variable seen = []
on work n, queued
 put n after seen
 wait 1 s
end work
on mark
 put 99 after seen
end mark
`})
	if err != nil {
		t.Fatal(err)
	}
	for _, n := range []int64{1, 2, 3} {
		if _, err := s.Deliver(Message{Name: "work", Args: []Value{Int(n)}}); err != nil {
			t.Fatal(err)
		}
	}
	s.Deliver(Message{Name: "mark"})
	now := time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC)
	r, err := g.Pump(now, PumpOptions{})
	if err != nil || r.State != Idle || len(r.Reports) != 1 {
		t.Fatal(r, err)
	}
	v := g.Inspect().Scripts[0]
	if v.Vars[0].Val.String() != "[1, 99]" || len(v.Runs) != 3 || v.Runs[0].Status != Suspended || v.Runs[1].Status != Parked || v.Runs[2].Status != Parked || len(v.Mailbox) != 0 {
		t.Fatal(v)
	}
	if s.Counters().MailboxLen != 0 {
		t.Fatal("parked Runs counted as mailbox messages")
	}
	for j, want := range []string{"[1, 99, 2]", "[1, 99, 2, 3]", "[1, 99, 2, 3]"} {
		r, err = g.Pump(now.Add(time.Duration(j+1)*time.Second), PumpOptions{})
		if err != nil || r.State != Idle || len(r.Reports) != 1 {
			t.Fatal(r, err)
		}
		if got := g.Inspect().Scripts[0].Vars[0].Val.String(); got != want {
			t.Fatal(got)
		}
	}
}

func TestPoliciesUseSelectedClauseAfterGuardFailure(t *testing.T) {
	var trace lines
	g := New().NewGroup(GroupOptions{Trace: &trace})
	s, err := g.Load(LoadOptions{Name: "s", Source: `script variable seen = []
on work n where n < 0, queued
 put n after seen
 wait 1 s
end work
on work n where 1 / 0 = 0, replacing
 put "wrong" after seen
end work
on work n, dropping
 put n after seen
 wait 1 s
end work
`})
	if err != nil {
		t.Fatal(err)
	}
	for _, n := range []int64{-1, 1, 2, -2} {
		s.Deliver(Message{Name: "work", Args: []Value{Int(n)}})
	}
	r, err := g.Pump(time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC), PumpOptions{})
	if err != nil || len(r.Reports) != 1 || r.Reports[0].(*RunEnd).Outcome != Dropped {
		t.Fatal(r, err)
	}
	v := g.Inspect().Scripts[0]
	if v.Vars[0].Val.String() != "[-1, 1]" || len(v.Runs) != 3 || v.Runs[2].Status != Parked {
		t.Fatal(v)
	}
	if !strings.Contains(strings.Join(trace, "\n"), "guard-skip s/r2") {
		t.Fatal(trace)
	}
}

func TestDroppingRequestSettlesWithDroppedReason(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: "on work, dropping\n wait 1 s\nend work\n"})
	if err != nil {
		t.Fatal(err)
	}
	s.Deliver(Message{Name: "work"})
	_, p, err := s.Request(nil, Message{Name: "work"})
	if err != nil {
		t.Fatal(err)
	}
	r, err := g.Pump(time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC), PumpOptions{})
	if err != nil || len(r.Reports) != 1 {
		t.Fatal(r, err)
	}
	end := r.Reports[0].(*RunEnd)
	if end.Outcome != Dropped || end.Fuel != 4 || end.Alloc != 0 {
		t.Fatal(end)
	}
	select {
	case <-p.Done():
	default:
		t.Fatal("dropped Request remains unsettled")
	}
	_, e := p.Result()
	if e == nil || e.Code != "send failed" || e.Data.Get("reason").String() != `"dropped"` {
		t.Fatal(e)
	}
}

func TestReplacingRunsQueueCleanupWithoutUndoingNewerWrites(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: `script variable seen = []
on work n, replacing
 try
  put n after seen
  wait 1 s
 finally
  put n * 10 after seen
 end try
end work
`})
	if err != nil {
		t.Fatal(err)
	}
	var pending []*Pending
	for _, n := range []int64{1, 2, 3} {
		_, p, err := s.Request(nil, Message{Name: "work", Args: []Value{Int(n)}})
		if err != nil {
			t.Fatal(err)
		}
		pending = append(pending, p)
	}
	now := time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC)
	r, err := g.Pump(now, PumpOptions{})
	if err != nil || len(r.Reports) != 2 {
		t.Fatal(r, err)
	}
	for j, end := range r.Reports {
		if e := end.(*RunEnd); e.Outcome != Cancelled || e.Run != RunID([]string{"s/r1", "s/r2"}[j]) {
			t.Fatal(e)
		}
	}
	if got := g.Inspect().Scripts[0]; got.Vars[0].Val.String() != "[1, 2, 3, 10, 20]" || len(got.Runs) != 1 {
		t.Fatal(got)
	}
	for _, p := range pending[:2] {
		select {
		case <-p.Done():
		default:
			t.Fatal("replaced Request unsettled")
		}
		_, e := p.Result()
		if e == nil || e.Data.Get("reason").String() != `"cancelled"` {
			t.Fatal(e)
		}
	}
	select {
	case <-pending[2].Done():
		t.Fatal("newest Request settled while waiting")
	default:
	}
	r, err = g.Pump(now.Add(time.Second), PumpOptions{})
	if err != nil || len(r.Reports) != 1 || r.Reports[0].(*RunEnd).Outcome != Completed {
		t.Fatal(r, err)
	}
	if got := g.Inspect().Scripts[0].Vars[0].Val.String(); got != "[1, 2, 3, 10, 20, 30]" {
		t.Fatal(got)
	}
}

func TestCancellingParkedRunKeepsClauseQueueAndCommittedState(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: `script variable seen = []
on work n, queued
 try
  put n after seen
  wait 1 s
 finally
  put n * 10 after seen
 end try
end work
`})
	if err != nil {
		t.Fatal(err)
	}
	s.Deliver(Message{Name: "work", Args: []Value{Int(1)}})
	id, p, err := s.Request(nil, Message{Name: "work", Args: []Value{Int(2)}})
	if err != nil {
		t.Fatal(err)
	}
	s.Deliver(Message{Name: "work", Args: []Value{Int(3)}})
	now := time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC)
	g.Pump(now, PumpOptions{})
	g.cancelDelivery(delivery{id: id, script: s, pending: p})
	r, err := g.Pump(now, PumpOptions{})
	if err != nil || len(r.Reports) != 1 || r.Reports[0].(*RunEnd).Outcome != Cancelled {
		t.Fatal(r, err)
	}
	v := g.Inspect().Scripts[0]
	if v.Vars[0].Val.String() != "[1, 20]" || len(v.Runs) != 2 || v.Runs[1].Status != Parked {
		t.Fatal(v)
	}
	g.Pump(now.Add(time.Second), PumpOptions{})
	if got := g.Inspect().Scripts[0].Vars[0].Val.String(); got != "[1, 20, 10, 3]" {
		t.Fatal(got)
	}
}

func TestReplacementRunsNestedFinallyBlocksInnermostFirst(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: `script variable seen = []
on work n, replacing
 try
  try
   put n after seen
   wait 1 s
  finally
   put n * 10 after seen
  end try
 finally
  put n * 100 after seen
 end try
end work
`})
	if err != nil {
		t.Fatal(err)
	}
	s.Deliver(Message{Name: "work", Args: []Value{Int(1)}})
	s.Deliver(Message{Name: "work", Args: []Value{Int(2)}})
	r, err := g.Pump(time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC), PumpOptions{})
	if err != nil || len(r.Reports) != 1 || r.Reports[0].(*RunEnd).Outcome != Cancelled {
		t.Fatal(r, err)
	}
	if got := g.Inspect().Scripts[0].Vars[0].Val.String(); got != "[1, 2, 10, 100]" {
		t.Fatal(got)
	}
}

func TestQueuedClauseReleasesAfterFaultWithFreshSegmentRollback(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Limits: Limits{FuelPerRun: 30}, Source: `script variable a = 0
on work n, queued
 wait 1 s
 put n into a
 repeat forever
 end repeat
end work
on mark
 put 7 into a
end mark
`})
	if err != nil {
		t.Fatal(err)
	}
	s.Deliver(Message{Name: "work", Args: []Value{Int(1)}})
	s.Deliver(Message{Name: "work", Args: []Value{Int(2)}})
	s.Deliver(Message{Name: "mark"})
	now := time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC)
	g.Pump(now, PumpOptions{})
	for j := 1; j <= 2; j++ {
		r, err := g.Pump(now.Add(time.Duration(j)*time.Second), PumpOptions{})
		if err != nil || len(r.Reports) != 1 {
			t.Fatal(r, err)
		}
		end := r.Reports[0].(*RunEnd)
		if end.Outcome != LimitFault || end.Limit != "fuel" || end.Fuel != 30 {
			t.Fatal(end)
		}
		if got := g.Inspect().Scripts[0].Vars[0].Val.String(); got != "7" {
			t.Fatal(got)
		}
	}
	if len(g.Inspect().Scripts[0].Runs) != 0 {
		t.Fatal("faulted owner did not release queued Run")
	}
}

func TestDroppedRunChecksEndingPersistentState(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Limits: Limits{PersistentState: 300}, Source: `on work n, dropping
 wait 1 s
end work
on later v
 return
end later
`})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC)
	s.Deliver(Message{Name: "work", Args: []Value{Int(1)}})
	g.Pump(now, PumpOptions{})
	large, err := Text(strings.Repeat("x", 1000))
	if err != nil {
		t.Fatal(err)
	}
	s.Deliver(Message{Name: "work", Args: []Value{Int(2)}})
	s.Deliver(Message{Name: "later", Args: []Value{large}})
	r, err := g.Pump(now, PumpOptions{FuelCap: 4})
	if err != nil || len(r.Reports) != 1 {
		t.Fatal(r, err)
	}
	end := r.Reports[0].(*RunEnd)
	if end.Outcome != LimitFault || end.Limit != "persistent" || end.Fuel != 4 {
		t.Fatal(end)
	}
	if got := g.Inspect().Scripts[0]; len(got.Runs) != 1 || len(got.Mailbox) != 1 {
		t.Fatal(got)
	}
}
