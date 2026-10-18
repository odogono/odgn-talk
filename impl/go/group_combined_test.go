package northtalk

import (
	"context"
	"testing"
	"time"
)

func TestCombinedRequestAdmissionAndPump(t *testing.T) {
	if experimentalGroupFactory != nil {
		t.Skip("native combined implementation")
	}
	ready := 0
	g := New().NewGroup(GroupOptions{OnReady: func() { ready++ }})
	s, err := g.Load(LoadOptions{Name: "s", Source: "script variable total = 0\non accumulate n\n put total + n into total\n return total\nend accumulate\n"})
	if err != nil {
		t.Fatal(err)
	}
	_, earlier, err := s.Request(nil, Message{Name: "accumulate", Args: []Value{Int(2)}})
	if err != nil {
		t.Fatal(err)
	}
	ready = 0
	id, p, result, err := s.requestPump(nil, Message{Name: "accumulate", Args: []Value{Int(3)}}, time.Now(), PumpOptions{})
	if err != nil || id == "" || p == nil || len(result.Reports) == 0 {
		t.Fatalf("%s %v %+v %v", id, p, result, err)
	}
	if v, e := earlier.Result(); e != nil || !v.Equal(Int(2)) {
		t.Fatalf("earlier: %v %v", v, e)
	}
	if v, e := p.Result(); e != nil || !v.Equal(Int(5)) {
		t.Fatalf("combined: %v %v", v, e)
	}
	if ready != 0 {
		t.Fatalf("combined initial admission notified %d times", ready)
	}
}

func TestCombinedPumpRefusalRetainsAdmission(t *testing.T) {
	if experimentalGroupFactory != nil {
		t.Skip("native combined implementation")
	}
	ready := 0
	g := New().NewGroup(GroupOptions{OnReady: func() { ready++ }})
	s, err := g.Load(LoadOptions{Name: "s", Source: "on ping\n return 42\nend ping\n"})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	if _, err := g.Pump(now, PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	id, p, _, err := s.requestPump(nil, Message{Name: "ping"}, now.Add(-time.Second), PumpOptions{})
	if err == nil || id == "" || p == nil {
		t.Fatalf("lost admission: %s %v %v", id, p, err)
	}
	select {
	case <-p.Done():
		t.Fatal("refused Pump executed request")
	default:
	}
	if ready != 1 {
		t.Fatalf("readiness: %d", ready)
	}
	if _, err := g.Pump(now, PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	if v, e := p.Result(); e != nil || !v.Equal(Int(42)) {
		t.Fatalf("%v %v", v, e)
	}
}

func TestCombinedRefusalDoesNotAdmit(t *testing.T) {
	if experimentalGroupFactory != nil {
		t.Skip("native combined implementation")
	}
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: "on ping\nend ping\n", Limits: Limits{MailboxDepth: 1}})
	if err != nil {
		t.Fatal(err)
	}
	if err := g.beginWorker(); err != nil {
		t.Fatal(err)
	}
	id, p, _, err := s.requestPump(context.Background(), Message{Name: "ping"}, time.Now(), PumpOptions{})
	g.endWorker()
	if err == nil || id != "" || p != nil || g.nextDelivery != 0 {
		t.Fatalf("worker refusal admitted: %s %v %v", id, p, err)
	}
	if _, err := s.Deliver(Message{Name: "ping"}); err != nil {
		t.Fatal(err)
	}
	id, p, _, err = s.requestPump(nil, Message{Name: "ping"}, time.Now(), PumpOptions{})
	if err != ErrMailboxFull || id != "" || p != nil || g.nextDelivery != 1 {
		t.Fatalf("mailbox refusal: %s %v %v", id, p, err)
	}
	if len(g.inputs) != 1 {
		t.Fatal("admission refusal pumped earlier work")
	}
}

func TestCombinedCallInvalidValueDoesNotPump(t *testing.T) {
	if experimentalGroupFactory != nil {
		t.Skip("native combined implementation")
	}
	g := New().NewGroup(GroupOptions{})
	id, p, _, err := g.callPump(nil, Int(1), nil, nil, time.Now(), PumpOptions{})
	if err == nil || id != "" || p != nil || !g.clock.IsZero() {
		t.Fatalf("%s %v %v", id, p, err)
	}
	if err := g.beginWorker(); err != nil {
		t.Fatal("worker guard leaked", err)
	}
	g.endWorker()
}

func TestCombinedFunctionCallAndStaleness(t *testing.T) {
	if experimentalGroupFactory != nil {
		t.Skip("native combined implementation")
	}
	g := New().NewGroup(GroupOptions{})
	home, fn := exportFunction(t, g, "on exported\n return given: 5\nend exported", Limits{})
	_, p, _, err := g.callPump(nil, fn, nil, nil, time.Unix(0, 0), PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if v, e := p.Result(); e != nil || !v.Equal(Int(5)) {
		t.Fatalf("%v %v", v, e)
	}
	if _, err := home.Reload("on other\nend other", ResetVariables); err != nil {
		t.Fatal(err)
	}
	id, p, _, err := g.callPump(nil, fn, nil, nil, time.Unix(0, 0), PumpOptions{})
	if err != nil || id == "" || p == nil {
		t.Fatalf("staleness rejected during admission: %s %v", id, err)
	}
	if _, e := p.Result(); e == nil {
		t.Fatal("stale Function succeeded")
	}
}

func TestCombinedOnePumpCanLeavePending(t *testing.T) {
	if experimentalGroupFactory != nil {
		t.Skip("native combined implementation")
	}
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: "on ping\n repeat 100 times\n end repeat\n return 42\nend ping\n"})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	_, p, r, err := s.requestPump(nil, Message{Name: "ping"}, now, PumpOptions{FuelSlice: 1})
	if err != nil || p == nil {
		t.Fatal(err)
	}
	select {
	case <-p.Done():
		t.Fatalf("unexpected completion after one slice: %+v", r)
	default:
	}
	if _, err := g.Pump(now, PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	if v, e := p.Result(); e != nil || !v.Equal(Int(42)) {
		t.Fatalf("%v %v", v, e)
	}
}

func TestCombinedRefusalNotifiesAfterWorkerRelease(t *testing.T) {
	if experimentalGroupFactory != nil {
		t.Skip("native combined implementation")
	}
	var g *Group
	g = New().NewGroup(GroupOptions{OnReady: func() {
		g.mu.Lock()
		held := g.pumping
		g.mu.Unlock()
		if held {
			t.Error("readiness published before worker guard release")
		}
	}})
	s, err := g.Load(LoadOptions{Name: "s", Source: "on ping\nend ping\n"})
	if err != nil {
		t.Fatal(err)
	}
	_, p, _, err := s.requestPump(nil, Message{Name: "ping"}, time.Now(), PumpOptions{FuelSlice: -1})
	if err == nil || p == nil {
		t.Fatal("expected admitted request and refused Pump", err)
	}
}
