package northtalk

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestDecisionVetoCompletesFinallyBeforeSealing(t *testing.T) {
	var trace lines
	g := New().NewGroup(GroupOptions{Trace: &trace})
	s, err := g.Load(LoadOptions{Name: "s", Source: `script variable checked = 0
on go, deciding
 try
  veto "blocked"
 finally
  add 1 to checked
 end try
end go
`})
	if err != nil {
		t.Fatal(err)
	}
	id, future, err := s.Decide(nil, Message{Name: "go"})
	if err != nil || id != "d1" {
		t.Fatal(id, err)
	}
	if future.Decided() != nil {
		t.Fatal("Decision settled before Pump")
	}
	r, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil || len(operationalReports(r.Reports)) != 2 {
		t.Fatal(r, err)
	}
	d := operationalReports(r.Reports)[0].(*Decided)
	if d.Verdict != Vetoed || len(d.Vetoes) != 1 || d.Vetoes[0].Reason.String() != `"blocked"` || d.Vetoes[0].Run != "s/r1" {
		t.Fatal(d)
	}
	if end := operationalReports(r.Reports)[1].(*RunEnd); end.Outcome != Completed || !end.Result.Equal(Nothing) {
		t.Fatal(end)
	}
	select {
	case <-future.Done():
	default:
		t.Fatal("Decision remains pending")
	}
	if g.Inspect().Scripts[0].Vars[0].Val.String() != "1" {
		t.Fatal(trace)
	}
	d.Vetoes[0].Script = "changed"
	copy := future.Decided()
	copy.Vetoes[0].Script = "also changed"
	if future.Decided().Vetoes[0].Script != "s" {
		t.Fatal("future exposes mutable report state")
	}
	if !strings.Contains(strings.Join(trace, "\n"), "end=veto") {
		t.Fatal(trace)
	}
}

func TestDecisionFirstWaitSealsAcrossPreemptionAndIgnoresLaterCancellation(t *testing.T) {
	ready := make(chan struct{}, 8)
	g := New().NewGroup(GroupOptions{OnReady: func() { ready <- struct{}{} }})
	s, err := g.Load(LoadOptions{Name: "s", Source: `script variable n = 0
on go, deciding
 put 1 into n
 wait 1 s
 put 2 into n
end go
`})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	_, future, err := s.Decide(ctx, Message{Name: "go"})
	if err != nil {
		t.Fatal(err)
	}
	<-ready
	now := time.Unix(0, 0)
	r, err := g.Pump(now, PumpOptions{FuelSlice: 5})
	if err != nil || r.State != Sliced || len(operationalReports(r.Reports)) != 0 || future.Decided() != nil {
		t.Fatal(r, err)
	}
	r, err = g.Pump(now, PumpOptions{})
	if err != nil || len(operationalReports(r.Reports)) != 1 || operationalReports(r.Reports)[0].(*Decided).Verdict != Allowed || len(g.Inspect().Scripts[0].Runs) != 1 {
		t.Fatal(r, err)
	}
	cancel()
	r, err = g.Pump(now.Add(time.Second), PumpOptions{})
	if err != nil || len(operationalReports(r.Reports)) != 1 || operationalReports(r.Reports)[0].(*RunEnd).Outcome != Completed || g.Inspect().Scripts[0].Vars[0].Val.String() != "2" {
		t.Fatal(r, err)
	}
	select {
	case <-ready:
		t.Fatal("sealed context cancellation queued work")
	default:
	}
}

func TestDecisionFailuresRemainUndecided(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		limits     *LimitOverride
		outcome    Outcome
	}{
		{"error", "return 1 / 0", nil, Errored},
		{"fuel", "veto", &LimitOverride{FuelPerRun: 4}, LimitFault},
	} {
		t.Run(tc.name, func(t *testing.T) {
			g := New().NewGroup(GroupOptions{})
			s, err := g.Load(LoadOptions{Name: "s", Source: "on go, deciding\n " + tc.body + "\nend go\n"})
			if err != nil {
				t.Fatal(err)
			}
			_, future, err := s.Decide(nil, Message{Name: "go", Limits: tc.limits})
			if err != nil {
				t.Fatal(err)
			}
			r, err := g.Pump(time.Unix(0, 0), PumpOptions{})
			if err != nil || len(operationalReports(r.Reports)) != 2 || operationalReports(r.Reports)[0].(*RunEnd).Outcome != tc.outcome {
				t.Fatal(r, err)
			}
			d := future.Decided()
			if d == nil || d.Verdict != Undecided || len(d.Undecided) != 1 || d.Undecided[0].Outcome != tc.outcome {
				t.Fatal(d)
			}
		})
	}
}

func TestDecisionOrdinaryClauseAllowsBeforeLaterError(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: "on go\n return 1 / 0\nend go\n"})
	if err != nil {
		t.Fatal(err)
	}
	_, future, err := s.Decide(nil, Message{Name: "go"})
	if err != nil {
		t.Fatal(err)
	}
	r, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil || len(operationalReports(r.Reports)) != 2 || operationalReports(r.Reports)[0].(*Decided).Verdict != Allowed || operationalReports(r.Reports)[1].(*RunEnd).Outcome != Errored || future.Decided().Verdict != Allowed {
		t.Fatal(r, err)
	}
}

func TestDecisionOrdinaryClauseCannotAllowUnpaidDispatch(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: "on go\n return 1 / 0\nend go\n"})
	if err != nil {
		t.Fatal(err)
	}
	_, future, err := s.Decide(nil, Message{Name: "go", Limits: &LimitOverride{FuelPerRun: 4}})
	if err != nil {
		t.Fatal(err)
	}
	r, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil || len(operationalReports(r.Reports)) != 2 || operationalReports(r.Reports)[0].(*RunEnd).Fuel != 0 || future.Decided().Verdict != Undecided {
		t.Fatal(r, err)
	}
}

func TestDecisionCancelledInMailboxOrPreemptedSegment(t *testing.T) {
	for _, started := range []bool{false, true} {
		t.Run(map[bool]string{false: "mailbox", true: "preempted"}[started], func(t *testing.T) {
			ready := make(chan struct{}, 8)
			g := New().NewGroup(GroupOptions{OnReady: func() { ready <- struct{}{} }})
			s, err := g.Load(LoadOptions{Name: "s", Source: `script variable n = 0
on go, deciding
 try
  put 1 into n
  repeat forever
  end repeat
 finally
  put 9 into n
 end try
end go
`})
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			_, future, err := s.Decide(ctx, Message{Name: "go"})
			if err != nil {
				t.Fatal(err)
			}
			<-ready
			if started {
				g.Pump(time.Unix(0, 0), PumpOptions{FuelSlice: 20})
			}
			cancel()
			select {
			case <-ready:
			case <-time.After(time.Second):
				t.Fatal("cancel was not queued")
			}
			r, err := g.Pump(time.Unix(0, 0), PumpOptions{})
			if err != nil || len(operationalReports(r.Reports)) != 2 || operationalReports(r.Reports)[0].(*RunEnd).Outcome != Cancelled {
				t.Fatal(r, err)
			}
			if d := future.Decided(); d == nil || d.Verdict != Undecided || d.Undecided[0].Outcome != Cancelled {
				t.Fatal(d)
			}
			want := "0"
			if started {
				want = "9"
			}
			if g.Inspect().Scripts[0].Vars[0].Val.String() != want {
				t.Fatal("incorrect cleanup state")
			}
		})
	}
}

func TestDecisionDroppingIsUndecidedAndReplacementPreservesSealedVerdict(t *testing.T) {
	for _, policy := range []string{"dropping", "replacing"} {
		t.Run(policy, func(t *testing.T) {
			g := New().NewGroup(GroupOptions{})
			s, err := g.Load(LoadOptions{Name: "s", Source: "on go, deciding, " + policy + "\n wait 1 s\nend go\n"})
			if err != nil {
				t.Fatal(err)
			}
			_, first, _ := s.Decide(nil, Message{Name: "go"})
			g.Pump(time.Unix(0, 0), PumpOptions{})
			_, second, _ := s.Decide(nil, Message{Name: "go"})
			r, err := g.Pump(time.Unix(0, 0), PumpOptions{})
			if err != nil || first.Decided().Verdict != Allowed {
				t.Fatal(r, err)
			}
			if policy == "dropping" {
				if second.Decided().Verdict != Undecided || second.Decided().Undecided[0].Outcome != Dropped {
					t.Fatal(second.Decided())
				}
			} else if second.Decided().Verdict != Allowed || operationalReports(r.Reports)[1].(*RunEnd).Outcome != Cancelled {
				t.Fatal(r)
			}
		})
	}
}
