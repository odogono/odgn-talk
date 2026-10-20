package northtalk

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestWaitForObservesEveryWaitBeforeHandlerWithoutConsumingMessage(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: `script variable seen = []
on watch id
 wait for paid {id: ^id, amount: a}
 put [it, a] after seen
end watch
on paid info
 put "handled" after seen
end paid
`})
	if err != nil {
		t.Fatal(err)
	}
	// A message dispatched before registration is missed.
	s.Deliver(Message{Name: "paid", Args: []Value{Int(0)}})
	for range 2 {
		s.Deliver(Message{Name: "watch", Args: []Value{Int(7)}})
	}
	now := time.Unix(0, 0)
	r, err := g.Pump(now, PumpOptions{})
	if err != nil || len(g.Inspect().Scripts[0].Runs) != 2 {
		t.Fatal(r, err)
	}
	s.Deliver(Message{Name: "paid", Args: []Value{Int(7)}}) // wrong shape
	s.Deliver(Message{Name: "paid"})                        // wrong arity
	m, _ := Map(KV("id", Int(7)), KV("amount", Int(20)))
	s.Deliver(Message{Name: "paid", Args: []Value{m}})
	r, err = g.Pump(now, PumpOptions{})
	view := g.Inspect().Scripts[0]
	if err != nil || len(view.Runs) != 0 || view.Vars[0].Val.String() != `["handled", "handled", "handled", [{name: "paid", args: [{id: 7, amount: 20}]}, 20], [{name: "paid", args: [{id: 7, amount: 20}]}, 20]]` {
		t.Fatal(r, err, view)
	}
}

func TestWaitForMatchAllowsDecisionBeforeDecidingHandlerVeto(t *testing.T) {
	var trace lines
	g := New().NewGroup(GroupOptions{Trace: &trace})
	s, err := g.Load(LoadOptions{Name: "s", Source: `script variable seen = 0
on watch
 wait for go x
 put x into seen
end watch
on go x, deciding
 veto x
end go
`})
	if err != nil {
		t.Fatal(err)
	}
	s.Deliver(Message{Name: "watch"})
	now := time.Unix(0, 0)
	g.Pump(now, PumpOptions{})
	_, future, err := s.Decide(nil, Message{Name: "go", Args: []Value{Int(9)}})
	if err != nil {
		t.Fatal(err)
	}
	r, err := g.Pump(now, PumpOptions{})
	if err != nil || future.Decided() == nil || future.Decided().Verdict != Allowed || len(operationalReports(r.Reports)) != 3 || operationalReports(r.Reports)[0].(*Decided).Verdict != Allowed {
		t.Fatal(r, err, future.Decided())
	}
	joined := strings.Join(trace, "\n")
	if !strings.Contains(joined, "note s/r2 kind=no-verdict") || g.Inspect().Scripts[0].Vars[0].Val.String() != "9" {
		t.Fatal(trace)
	}
}

func TestWaitForBlockChoosesFirstMatchingBranchAndEarliestTimeout(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: `script variable seen = []
on watch
 wait for
  when go x where 1 / 0 = 1 then
   put "error" after seen
  when go x where x > 0 then
   put x after seen
  when go x then
   put "later" after seen
  after 2 s then
   put "two" after seen
  after 1 s then
   put it after seen
  after 1 s then
   put "tie" after seen
 end wait
end watch
`})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Unix(0, 0)
	s.Deliver(Message{Name: "watch"})
	r, err := g.Pump(now, PumpOptions{})
	if err != nil || !r.NextDeadline.Equal(now.Add(time.Second)) {
		t.Fatal(r, err)
	}
	s.Deliver(Message{Name: "go", Args: []Value{Int(3)}})
	r, err = g.Pump(now, PumpOptions{})
	if err != nil || !r.NextDeadline.IsZero() {
		t.Fatal(r, err)
	}
	s.Deliver(Message{Name: "watch"})
	g.Pump(now, PumpOptions{})
	g.Pump(now.Add(2*time.Second), PumpOptions{})
	if got := g.Inspect().Scripts[0]; len(got.Runs) != 0 || got.Vars[0].Val.String() != "[3, nothing]" {
		t.Fatal(got)
	}
}

func TestWaitForTimeoutResumesWithNothingInLaterPump(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: "script variable seen = 1\non watch\n wait for absent or 0 s\n put it into seen\nend watch\n"})
	if err != nil {
		t.Fatal(err)
	}
	s.Deliver(Message{Name: "watch"})
	now := time.Unix(0, 0)
	r, err := g.Pump(now, PumpOptions{})
	view := g.Inspect().Scripts[0]
	if err != nil || len(view.Runs) != 1 || view.Runs[0].Status != Suspended || view.Runs[0].Wait != "wait-for" || !r.NextDeadline.Equal(now) || view.Vars[0].Val.String() != "1" {
		t.Fatal(r, err, view)
	}
	g.Pump(now, PumpOptions{})
	if got := g.Inspect().Scripts[0]; len(got.Runs) != 0 || !got.Vars[0].Val.Equal(Nothing) {
		t.Fatal(got)
	}
}

func TestWaitForObservationExceedsSliceBeforeDispatchAndRunLimits(t *testing.T) {
	var trace lines
	g := New().NewGroup(GroupOptions{Trace: &trace})
	s, err := g.Load(LoadOptions{Name: "s", Source: `on watch
 wait for go x
end watch
on go x, deciding
 veto x
end go
`})
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		s.Deliver(Message{Name: "watch", Limits: &LimitOverride{FuelPerRun: 14, AllocPerRun: 1}})
	}
	now := time.Unix(0, 0)
	g.Pump(now, PumpOptions{})
	_, future, _ := s.Decide(nil, Message{Name: "go", Args: []Value{Int(3)}})
	r, err := g.Pump(now, PumpOptions{FuelSlice: 4})
	view := g.Inspect().Scripts[0]
	// Each event test pays load (1), list (4) and return (2), without the
	// Handler-only dispatch rate. Both tests finish before preemption.
	if err != nil || r.FuelUsed != 14 || r.State != Sliced || future.Decided() == nil || future.Decided().Verdict != Allowed || len(view.Runs) != 3 || view.Runs[0].Status != Ready || view.Runs[1].Status != Ready || view.Runs[2].Status != Preempted {
		t.Fatal(r, err, view)
	}
	if !strings.Contains(strings.Join(trace, "\n"), "preempt s/r3 start delivery=d3 handler=go clause=1 by=slice fuel=0 alloc=0") {
		t.Fatal(trace)
	}
	for range 2 {
		r, err = g.Pump(now, PumpOptions{FuelSlice: 4})
		if err != nil || r.FuelUsed != 0 || r.State != Sliced {
			t.Fatal(r, err)
		}
	}
	r, err = g.Pump(now, PumpOptions{})
	if err != nil || len(operationalReports(r.Reports)) != 3 || operationalReports(r.Reports)[0].(*RunEnd).Outcome != Completed || operationalReports(r.Reports)[1].(*RunEnd).Outcome != LimitFault || operationalReports(r.Reports)[2].(*RunEnd).Outcome != LimitFault || len(g.Inspect().Scripts[0].Runs) != 0 {
		t.Fatal(r, err)
	}
}

func TestWaitForObservesInternalErrorWithoutAnErrorHandler(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: `script variable seen = nothing
on watch
 wait for error e from s
 put the code of e into seen
end watch
on broken
 return 1 / 0
end broken
`})
	if err != nil {
		t.Fatal(err)
	}
	s.Deliver(Message{Name: "watch"})
	s.Deliver(Message{Name: "broken"})
	r, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil || len(operationalReports(r.Reports)) != 2 || g.Inspect().Scripts[0].Vars[0].Val.String() != `"division by zero"` {
		t.Fatal(r, err)
	}
}

func TestWaitForInvalidFilterRaisesBeforeRegistration(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: "on watch\n wait for go from 7\nend watch\n"})
	if err != nil {
		t.Fatal(err)
	}
	s.Deliver(Message{Name: "watch"})
	r, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil || len(operationalReports(r.Reports)) != 1 || operationalReports(r.Reports)[0].(*RunEnd).Error.Code != "wrong kind" || len(g.Inspect().Scripts[0].Runs) != 0 {
		t.Fatal(r, err)
	}
}

func TestWaitForBeyondClockRangeStillObservesMessages(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: "on watch\n wait for go or 1000000000000000000000000000000000 s\nend watch\n"})
	if err != nil {
		t.Fatal(err)
	}
	s.Deliver(Message{Name: "watch"})
	r, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil || r.FuelUsed != 15 || !r.NextDeadline.IsZero() || len(g.Inspect().Scripts[0].Runs) != 1 || g.Inspect().Scripts[0].Runs[0].Status != Suspended {
		t.Fatal(r, err)
	}
	if _, err := s.Deliver(Message{Name: "go"}); err != nil {
		t.Fatal(err)
	}
	if r, err := g.Pump(time.Unix(1, 0), PumpOptions{}); err != nil || len(g.Inspect().Scripts[0].Runs) != 0 || !r.NextDeadline.IsZero() {
		t.Fatal(r, err)
	}
}

func TestOwnerlessPassCompletesRunThenAllowsAtEndOfPath(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: "on go, deciding\n pass go\nend go\n"})
	if err != nil {
		t.Fatal(err)
	}
	_, future, _ := s.Decide(nil, Message{Name: "go"})
	r, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil || len(operationalReports(r.Reports)) != 3 || operationalReports(r.Reports)[0].(*RunEnd).Outcome != Completed || operationalReports(r.Reports)[0].(*RunEnd).Fuel != 24 || operationalReports(r.Reports)[1].(*Unhandled).Message.Name != "go" || future.Decided().Verdict != Allowed {
		t.Fatal(r, err)
	}
}

func TestWaitForNamedScriptWaitsForOneLoadedLater(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: "script variable got\non watch\n wait for go from later\n put \"go\" into got\nend watch\n"})
	if err != nil {
		t.Fatal(err)
	}
	s.Deliver(Message{Name: "watch"})
	now := time.Unix(0, 0)
	if r, err := g.Pump(now, PumpOptions{}); err != nil || len(operationalReports(r.Reports)) != 0 {
		t.Fatal(r, err)
	}
	later, err := g.Load(LoadOptions{Name: "later", Source: "on fire\n send go to s\nend fire\n"})
	if err != nil {
		t.Fatal(err)
	}
	later.Deliver(Message{Name: "fire"})
	g.Pump(now, PumpOptions{})
	g.Pump(now, PumpOptions{})
	if want, _ := Text("go"); !g.Inspect().Scripts[0].Vars[0].Val.Equal(want) {
		t.Fatal(g.Inspect())
	}
}

func TestWaitForResumesInRegistrationOrderAcrossEarlierSuspension(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: `script variable seen = []
on older
 wait 0 s
 wait for go
 put "older" after seen
end older
on newer
 wait for go
 put "newer" after seen
end newer
`})
	if err != nil {
		t.Fatal(err)
	}
	s.Deliver(Message{Name: "older"})
	s.Deliver(Message{Name: "newer"})
	now := time.Unix(0, 0)
	g.Pump(now, PumpOptions{})
	g.Pump(now, PumpOptions{})
	s.Deliver(Message{Name: "go"})
	g.Pump(now, PumpOptions{})
	if got := g.Inspect().Scripts[0].Vars[0].Val.String(); got != `["newer", "older"]` {
		t.Fatal(got)
	}
}

func TestWaitForCancellationRemovesSubscriptionTimerAndReadyEvent(t *testing.T) {
	for _, matched := range []bool{false, true} {
		t.Run(map[bool]string{false: "pending", true: "ready"}[matched], func(t *testing.T) {
			ready := make(chan struct{}, 1)
			g := New().NewGroup(GroupOptions{OnReady: func() {
				select {
				case ready <- struct{}{}:
				default:
				}
			}})
			s, err := g.Load(LoadOptions{Name: "s", Source: `script variable seen = []
on watch
 try
  wait for go x or 1 s
  put "resumed" after seen
 finally
  put "cleanup" after seen
 end try
end watch
on go x
end go
`})
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			_, _, err = s.Request(ctx, Message{Name: "watch"})
			if err != nil {
				t.Fatal(err)
			}
			now := time.Unix(0, 0)
			g.Pump(now, PumpOptions{})
			if matched {
				s.Deliver(Message{Name: "go", Args: []Value{Int(1)}})
				g.Pump(now, PumpOptions{FuelCap: 1})
			}
			// Cancel through the public context, waiting for its admission
			// through OnReady, so either Core sees it.
			select {
			case <-ready:
			default:
			}
			cancel()
			select {
			case <-ready:
			case <-time.After(5 * time.Second):
				t.Fatal("cancellation did not notify OnReady")
			}
			r, err := g.Pump(now.Add(time.Second), PumpOptions{})
			if err != nil || !r.NextDeadline.IsZero() || g.Inspect().Scripts[0].Vars[0].Val.String() != `["cleanup"]` || len(g.Inspect().Scripts[0].Runs) != 0 {
				t.Fatal(r, err)
			}
		})
	}
}

func TestWaitForObservationAllocationFaultWaitsUntilResumption(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: "on watch\n wait for go x\nend watch\n"})
	if err != nil {
		t.Fatal(err)
	}
	s.Deliver(Message{Name: "watch", Limits: &LimitOverride{AllocPerRun: 1}})
	now := time.Unix(0, 0)
	g.Pump(now, PumpOptions{})
	s.Deliver(Message{Name: "go", Args: []Value{Int(1)}})
	r, err := g.Pump(now, PumpOptions{FuelCap: 1})
	if err != nil || r.FuelUsed != 7 || s.Counters().Faults != 0 {
		t.Fatal(r, err)
	}
	r, err = g.Pump(now, PumpOptions{})
	if err != nil || len(operationalReports(r.Reports)) != 1 || operationalReports(r.Reports)[0].(*RunEnd).Limit != "alloc" || operationalReports(r.Reports)[0].(*RunEnd).Fuel != 21 || operationalReports(r.Reports)[0].(*RunEnd).Alloc != 40 {
		t.Fatal(r, err)
	}
}

// A one-line `wait for` takes a Guard after any timeout, and an `or` in the
// Guard is boolean (ADR 0109). watched gives what the wait left in `it` once
// `key` messages carrying each of keys have been dispatched and the Clock
// has reached until, or "waiting".
func TestOneLineWaitForGuard(t *testing.T) {
	watched := func(wait string, keys []string, until time.Duration) string {
		t.Helper()
		g := New().NewGroup(GroupOptions{})
		s, err := g.Load(LoadOptions{Name: "s", Source: "script variable seen = \"waiting\"\non watch\n " + wait + "\n put it into seen\nend watch\non key k\nend key\n"})
		if err != nil {
			t.Fatal(err)
		}
		s.Deliver(Message{Name: "watch"})
		t0 := time.Unix(0, 0)
		if _, err := g.Pump(t0, PumpOptions{}); err != nil {
			t.Fatal(err)
		}
		for _, k := range keys {
			v, err := Text(k)
			if err != nil {
				t.Fatal(err)
			}
			s.Deliver(Message{Name: "key", Args: []Value{v}})
			if _, err := g.Pump(t0, PumpOptions{}); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := g.Pump(t0.Add(until), PumpOptions{}); err != nil {
			t.Fatal(err)
		}
		return g.Inspect().Scripts[0].Vars[0].Val.String()
	}
	for _, tc := range []struct {
		wait  string
		keys  []string
		until time.Duration
		want  string
	}{
		{`wait for key k where k = "Y"`, []string{"N"}, 0, `"waiting"`},
		{`wait for key k where k = "Y"`, []string{"N", "Y"}, 0, `{name: "key", args: ["Y"]}`},
		{`wait for key k where k = "Y" or k = "N"`, []string{"A", "N"}, 0, `{name: "key", args: ["N"]}`},
		{`wait for key k or 5 s where k = "Y"`, []string{"N"}, 4 * time.Second, `"waiting"`},
		{`wait for key k or 5 s where k = "Y"`, []string{"N"}, 5 * time.Second, `nothing`},
		{`wait for key k or 5 s where k = "Y"`, []string{"N", "Y"}, 5 * time.Second, `{name: "key", args: ["Y"]}`},
	} {
		if got := watched(tc.wait, tc.keys, tc.until); got != tc.want {
			t.Errorf("%s after %v, %v: got %s, want %s", tc.wait, tc.keys, tc.until, got, tc.want)
		}
	}
}
