package northtalk

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

type timerHost struct {
	schedule func(*Call, string, Value, string, Value) error
	cancel   func(*Call, string) error
}

func (h *timerHost) Schedule(c *Call, name string, at Value, message string, args Value) error {
	return h.schedule(c, name, at, message, args)
}
func (h *timerHost) Cancel(c *Call, name string) error { return h.cancel(c, name) }
func testTimerHost() *timerHost {
	return &timerHost{schedule: func(*Call, string, Value, string, Value) error { return nil }, cancel: func(*Call, string) error { return nil }}
}

func TestStandardFactoryCostsAndNilImplementation(t *testing.T) {
	core := New()
	for _, costs := range []Costs{nil, {}, {"extra": {}}, {"now": {Fuel: -1}}, {"now": {Alloc: -1}}, {"now": {Fuel: 9007199254740992}}, {"now": {Alloc: 9007199254740992}}} {
		def, err := core.ClockCapability(costs)
		var host *HostError
		if def != nil || !errors.As(err, &host) || host.Code != InvalidValue {
			t.Fatalf("ClockCapability(%v) = %v, %v", costs, def, err)
		}
	}
	for _, costs := range []Costs{nil, {"schedule": {}}, {"cancel": {}}, {"schedule": {}, "cancel": {Fuel: -1}}} {
		def, err := core.TimerCapability(testTimerHost(), costs)
		var host *HostError
		if def != nil || !errors.As(err, &host) || host.Code != InvalidValue {
			t.Fatalf("TimerCapability(%v) = %v, %v", costs, def, err)
		}
	}
	for _, impl := range []TimerImpl{nil, (*timerHost)(nil)} {
		def, err := core.TimerCapability(impl, Costs{"schedule": {}, "cancel": {}})
		var host *HostError
		if def != nil || !errors.As(err, &host) || host.Code != InvalidValue {
			t.Fatalf("nil TimerCapability = %v, %v", def, err)
		}
	}
	if _, err := core.ClockCapability(Costs{"now": {Fuel: 9007199254740991, Alloc: 9007199254740991}, "ignored": {Fuel: -1}}); err != nil {
		t.Fatal(err)
	}
	if _, err := core.TimerCapability(testTimerHost(), Costs{"schedule": {}, "cancel": {}, "ignored": {Fuel: -1}}); err != nil {
		t.Fatal(err)
	}
}

func TestClockFactoryUsesPumpReadingAndCopiesCost(t *testing.T) {
	costs := Costs{"now": {Fuel: 7, Alloc: 2}}
	core := New()
	def, err := core.ClockCapability(costs)
	if err != nil || def.Name() != "clock" {
		t.Fatalf("%v, %v", def, err)
	}
	costs["now"] = Cost{Fuel: 100000, Alloc: 100000}
	delete(costs, "now")
	var trace lines
	g := core.NewGroup(GroupOptions{Trace: &trace})
	s, err := g.Load(LoadOptions{Name: "s", Source: "on go\n ask stamp to now\n return it\nend go\n", Grants: map[string]*Grant{"stamp": def.GrantAll(nil)}, Limits: Limits{FuelPerRun: 100, AllocPerRun: 100}})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 2, 10, 0, 0, 123456789, time.FixedZone("zone", 3600))
	for _, reading := range []time.Time{now, now, now.Add(time.Nanosecond)} {
		_, p, err := s.Request(context.Background(), Message{Name: "go"})
		if err != nil {
			t.Fatal(err)
		}
		result, err := g.Pump(reading, PumpOptions{})
		if err != nil {
			t.Fatal(err)
		}
		value, failure := p.Result()
		if failure != nil || !value.Equal(InstantFromTime(reading)) {
			t.Fatalf("%v, %v; %+v", value, failure, result)
		}
	}
	if !strings.Contains(strings.Join(trace, "\n"), "op=stamp.now args=[] result=2026-10-02T09:00:00.123456789Z") {
		t.Fatal(trace)
	}
	if _, err := g.Load(LoadOptions{Name: "missing", Source: "on go\n ask clock to now\nend go\n"}); err == nil {
		t.Fatal("ungranted clock loaded")
	}
	if _, err := g.Load(LoadOptions{Name: "wrong", Source: "on go\n tell stamp to now\nend go\n", Grants: map[string]*Grant{"stamp": def.GrantAll(nil)}}); err == nil {
		t.Fatal("fire-and-forget Clock loaded")
	}
}

func TestTimerFactoryForwardsCallerAndHostOwnsDelivery(t *testing.T) {
	core := New()
	now := time.Date(2026, 10, 2, 10, 0, 0, 0, time.UTC)
	at := InstantFromTime(now.Add(time.Second))
	var scheduled *Call
	var cancelled *Call
	host := &timerHost{
		schedule: func(c *Call, name string, instant Value, message string, args Value) error {
			scheduled = c
			if name != "wake" || !instant.Equal(at) || message != "tick" || !args.Equal(List(Int(9))) {
				t.Fatalf("%s, %v, %s, %v", name, instant, message, args)
			}
			return c.Charge(5)
		},
		cancel: func(c *Call, name string) error {
			cancelled = c
			if name != "unknown" {
				t.Fatal(name)
			}
			return nil
		},
	}
	costs := Costs{"schedule": {Fuel: 10, Alloc: 3}, "cancel": {Fuel: 2}}
	def, err := core.TimerCapability(host, costs)
	if err != nil || def.Name() != "timer" {
		t.Fatalf("%v, %v", def, err)
	}
	costs["schedule"] = Cost{Fuel: 100000, Alloc: 100000}
	costs["cancel"] = Cost{Fuel: 100000, Alloc: 100000}
	var trace lines
	g := core.NewGroup(GroupOptions{Trace: &trace})
	s, err := g.Load(LoadOptions{Name: "s", Source: "script variable seen = []\non go at\n tell alarm to schedule \"wake\", at, \"tick\", [9]\n tell alarm to cancel \"unknown\"\nend go\non tick x\n put x after seen\nend tick\n", Grants: map[string]*Grant{"alarm": def.GrantAll("tenant")}, Limits: Limits{FuelPerRun: 200, AllocPerRun: 200}})
	if err != nil {
		t.Fatal(err)
	}
	s.Deliver(Message{Name: "go", Args: []Value{at}})
	if _, err = g.Pump(now, PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	for _, c := range []*Call{scheduled, cancelled} {
		if c == nil || c.ScriptName() != "s" || c.RunID() != "s/r1" || c.GrantName() != "alarm" || c.Binding() != "tenant" || c.Group() != g || !c.Now().Equal(now) {
			t.Fatalf("%+v", c)
		}
	}
	if scheduled.ID() != "s/r1.c1" || cancelled.ID() != "s/r1.c2" {
		t.Fatal(scheduled.ID(), cancelled.ID())
	}
	if _, err = g.Pump(now.Add(time.Second), PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	if !g.Inspect().Scripts[0].Vars[0].Val.Equal(List()) {
		t.Fatal("Core delivered a Host-owned timer")
	}
	s.Deliver(Message{Name: "tick", Args: []Value{Int(9)}})
	if _, err = g.Pump(now.Add(time.Second), PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	if !g.Inspect().Scripts[0].Vars[0].Val.Equal(List(Int(9))) {
		t.Fatal("Host Delivery lost")
	}
	if !strings.Contains(strings.Join(trace, "\n"), `op=alarm.schedule args=["wake", 2026-10-02T10:00:01Z, "tick", [9]] charged=5`) {
		t.Fatal(trace)
	}
}

func TestTimerFactoryChecksBeforeHostAndMapsFailures(t *testing.T) {
	for _, test := range []struct {
		name, payload, code, limit string
		limits                     Limits
		cost                       Cost
		hostFailure                error
		panicHost                  bool
		invoked                    bool
	}{
		{name: "wrong kind", payload: `3`, code: "wrong kind"},
		{name: "nested function", payload: `[{callback: given x: x}]`, code: "not encodable"},
		{name: "declared fuel", payload: `[]`, cost: Cost{Fuel: 100}, limits: Limits{FuelPerRun: 30}, limit: "fuel"},
		{name: "declared allocation", payload: `[]`, cost: Cost{Alloc: 100}, limits: Limits{AllocPerRun: 40}, limit: "alloc"},
		{name: "Host failure", payload: `[]`, hostFailure: errors.New("Host detail"), code: "host error", invoked: true},
		{name: "undeclared Script error", payload: `[]`, hostFailure: &ScriptError{Code: "timer failed"}, code: "host error", invoked: true},
		{name: "Host panic", payload: `[]`, panicHost: true, code: "host error", invoked: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			core := New()
			invoked := false
			host := testTimerHost()
			host.schedule = func(*Call, string, Value, string, Value) error {
				invoked = true
				if test.panicHost {
					panic("Host detail")
				}
				return test.hostFailure
			}
			def, err := core.TimerCapability(host, Costs{"schedule": test.cost, "cancel": {}})
			if err != nil {
				t.Fatal(err)
			}
			var trace lines
			g := core.NewGroup(GroupOptions{Trace: &trace})
			source := "script variable touched = 0\non go at\n put 1 into touched\n put " + test.payload + " into payload\n tell alarm to schedule \"wake\", at, \"tick\", payload\nend go\n"
			s, err := g.Load(LoadOptions{Name: "s", Source: source, Limits: test.limits, Grants: map[string]*Grant{"alarm": def.GrantAll(nil)}})
			if err != nil {
				t.Fatal(err)
			}
			s.Deliver(Message{Name: "go", Args: []Value{InstantFromTime(time.Date(2026, 10, 2, 10, 0, 0, 0, time.UTC))}})
			result, err := g.Pump(time.Date(2026, 10, 2, 10, 0, 0, 0, time.UTC), PumpOptions{})
			if err != nil {
				t.Fatal(err)
			}
			end := joinEnd(t, result, "s")
			if invoked != test.invoked {
				t.Fatalf("invoked=%v, want %v", invoked, test.invoked)
			}
			if test.limit != "" {
				if end.Outcome != LimitFault || end.Limit != test.limit || !g.Inspect().Scripts[0].Vars[0].Val.Equal(Int(0)) {
					t.Fatalf("%+v", end)
				}
			} else if end.Outcome != Errored || end.Error == nil || end.Error.Code != test.code {
				t.Fatalf("%+v", end)
			}
			hasCall := strings.Contains(strings.Join(trace, "\n"), "call s/r1.c1")
			if hasCall != test.invoked {
				t.Fatal(trace)
			}
		})
	}
}
