package northtalk

import (
	"testing"
	"time"
)

func TestCombinedRequestAdmissionAndPump(t *testing.T) {
	setZigRequestPumpLayout(t, "fields")
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
	id, p, result, err := s.RequestPump(nil, Message{Name: "accumulate", Args: []Value{Int(3)}}, time.Now(), PumpOptions{})
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
	setZigRequestPumpLayout(t, "fields")
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
	id, p, _, err := s.RequestPump(nil, Message{Name: "ping"}, now.Add(-time.Second), PumpOptions{})
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

func TestCombinedCallInvalidValueDoesNotPump(t *testing.T) {
	setZigRequestPumpLayout(t, "fields")
	g := New().NewGroup(GroupOptions{})
	id, p, _, err := g.CallPump(nil, Int(1), nil, nil, time.Now(), PumpOptions{})
	if err == nil || id != "" || p != nil || !g.clock.IsZero() {
		t.Fatalf("%s %v %v", id, p, err)
	}
	if err := g.beginWorker(); err != nil {
		t.Fatal("worker guard leaked", err)
	}
	g.endWorker()
}

func TestCombinedFunctionCallAndStaleness(t *testing.T) {
	setZigRequestPumpLayout(t, "fields")
	g := New().NewGroup(GroupOptions{})
	home, fn := exportFunction(t, g, "on exported\n return given: 5\nend exported", Limits{})
	_, p, _, err := g.CallPump(nil, fn, nil, nil, time.Unix(0, 0), PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if v, e := p.Result(); e != nil || !v.Equal(Int(5)) {
		t.Fatalf("%v %v", v, e)
	}
	if _, err := home.Reload("on other\nend other", ResetVariables); err != nil {
		t.Fatal(err)
	}
	id, p, _, err := g.CallPump(nil, fn, nil, nil, time.Unix(0, 0), PumpOptions{})
	if err != nil || id == "" || p == nil {
		t.Fatalf("staleness rejected during admission: %s %v", id, err)
	}
	if _, e := p.Result(); e == nil {
		t.Fatal("stale Function succeeded")
	}
}

func TestCombinedOnePumpCanLeavePending(t *testing.T) {
	setZigRequestPumpLayout(t, "fields")
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: "on ping\n repeat 100 times\n end repeat\n return 42\nend ping\n"})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	_, p, r, err := s.RequestPump(nil, Message{Name: "ping"}, now, PumpOptions{FuelSlice: 1})
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
	setZigRequestPumpLayout(t, "fields")
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
	_, p, _, err := s.RequestPump(nil, Message{Name: "ping"}, time.Now(), PumpOptions{FuelSlice: -1})
	if err == nil || p == nil {
		t.Fatal("expected admitted request and refused Pump", err)
	}
}

func testCombinedObjectRequest(t *testing.T) {
	core := New()
	g := core.NewGroup(GroupOptions{})
	kind := objectKindForTest(t, core, "combined-item")
	owner, err := g.Object(kind, "owner", nil)
	if err != nil {
		t.Fatal(err)
	}
	child, err := g.Object(kind, "child", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := g.SetParent(child, owner); err != nil {
		t.Fatal(err)
	}
	_, err = g.Load(LoadOptions{Name: "s", Owner: owner, Source: "on ping\n return the id of the target\nend ping\n"})
	if err != nil {
		t.Fatal(err)
	}
	id, p, r, err := g.RequestPump(nil, child, Message{Name: "ping"}, time.Unix(1, 0), PumpOptions{})
	if err != nil || id == "" || p == nil || len(r.Reports) == 0 {
		t.Fatalf("%s %v %+v %v", id, p, r, err)
	}
	if v, e := p.Result(); e != nil || v.String() != `"child"` {
		t.Fatal(v, e)
	}
}

func testCombinedCallArityAtExecution(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	_, fn := exportFunction(t, g, "function sum a, b = 5\n return a + b\nend sum\non exported\n return sum\nend exported", Limits{})
	_, p, _, err := g.CallPump(nil, fn, []Value{Int(2)}, nil, time.Unix(1, 0), PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if v, e := p.Result(); e != nil || !v.Equal(Int(7)) {
		t.Fatal(v, e)
	}
	id, p, r, err := g.CallPump(nil, fn, nil, nil, time.Unix(1, 0), PumpOptions{})
	if err != nil || id == "" || p == nil {
		t.Fatalf("arity refused admission: %s %v", id, err)
	}
	_, failure := p.Result()
	if failure == nil || failure.Data.Get("error").Get("code").String() != `"wrong arity"` {
		t.Fatal(failure, r)
	}
}
