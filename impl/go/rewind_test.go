package northtalk

import (
	"testing"
	"time"
)

// rewinding loads a Script whose `go` rewinds its own Run at the `rewind`
// crossing the first time, as a debugger landing a Rewind there would (ADR 0068).
func rewinding(t *testing.T) (*Group, *Script) {
	t.Helper()
	core := New()
	rewound := false
	def, err := core.DefineCapability(t.Name(), Operation{Name: "rewind", Mode: Immediate, Cost: Cost{Fuel: 1}, Do: func(c *Call, _ []Value) (Value, error) {
		if !rewound {
			rewound = true
			c.Group().Script("s").RewindRun(c.RunID())
		}
		return Nothing, nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	g := core.NewGroup(GroupOptions{Name: "g"})
	s, err := g.Load(LoadOptions{Name: "s", Source: "script variable n = 0\non go\n add 1 to n\n ask api to rewind\n return n\nend go", Grants: map[string]*Grant{"api": def.GrantAll(nil)}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Deliver(Message{Name: "go"}); err != nil {
		t.Fatal(err)
	}
	return g, s
}

func TestRewindEndsThePumpAndDiscardsTheRun(t *testing.T) {
	g, s := rewinding(t)
	result, err := g.Pump(time.Time{}, PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if result.State != Rewound || len(result.Reports) != 4 {
		t.Fatalf("%v %+v", result.State, result.Reports)
	}
	discarded, ok := result.Reports[1].(*RunDiscarded)
	if !ok || discarded.Run != "s/r1" || discarded.RootDelivery != "d1" || discarded.Reason != "rewind" {
		t.Fatalf("%+v", result.Reports[1])
	}
	row := result.Reports[2].(*RunAccounting)
	if row.Run != "s/r1" || row.State != "discarded" || row.Fuel != result.FuelUsed {
		t.Fatalf("%+v", row)
	}
	// The message waits in the mailbox again, and no Run is live.
	causal := result.Reports[3].(*CausalWork)
	if causal.RootDelivery != "d1" || causal.LiveRuns != 0 || causal.QueuedMessages != 1 {
		t.Fatalf("%+v", causal)
	}
	if c := s.Counters(); c.MailboxLen != 1 {
		t.Fatalf("%+v", c)
	}
}

func TestReloadKeepingTheMailboxRunsTheRewoundMessage(t *testing.T) {
	g, s := rewinding(t)
	if _, err := g.Pump(time.Time{}, PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	reports, err := s.Reload("script variable n = 0\non go\n return n + 10\nend go", CarryVariables, ReloadOptions{KeepMailbox: true})
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range reports {
		if stop, ok := r.(*Stop); ok && (len(stop.DiscardedRuns) != 0 || len(stop.DroppedMessages) != 0) {
			t.Fatalf("%+v", stop)
		}
	}
	result, err := g.Pump(time.Time{}, PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	var end *RunEnd
	for _, r := range result.Reports {
		if e, ok := r.(*RunEnd); ok {
			end = e
		}
	}
	// n rolled back with the Segment, so the new code sees 0.
	if result.State != Idle || end == nil || end.Run != "s/r2" || end.Delivery != "d1" || !end.Result.Equal(Int(10)) {
		t.Fatalf("%v %+v", result.State, end)
	}
}

func TestOrdinaryReloadDropsTheRewoundMessage(t *testing.T) {
	g, s := rewinding(t)
	if _, err := g.Pump(time.Time{}, PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	reports, err := s.Reload("on go\nend go", ResetVariables)
	if err != nil {
		t.Fatal(err)
	}
	dropped := false
	for _, r := range reports {
		if stop, ok := r.(*Stop); ok {
			dropped = len(stop.DroppedMessages) == 1 && stop.DroppedMessages[0] == "d1"
		}
	}
	if !dropped {
		t.Fatalf("%+v", reports)
	}
}

func TestRewindPastTheFirstSegmentDoesNothing(t *testing.T) {
	g := New().NewGroup(GroupOptions{Name: "g"})
	s, err := g.Load(LoadOptions{Name: "s", Source: "on go\n wait 1 s\n return 1\nend go"})
	if err != nil {
		t.Fatal(err)
	}
	s.Deliver(Message{Name: "go"})
	if _, err := g.Pump(time.Time{}, PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	s.RewindRun("s/r1")
	result, err := g.Pump(time.Time{}.Add(time.Millisecond), PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range result.Reports {
		if _, ok := r.(*RunDiscarded); ok || result.State == Rewound {
			t.Fatalf("%v %+v", result.State, result.Reports)
		}
	}
}
