package northtalk

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestImmediateAndFireOperations(t *testing.T) {
	core := New()
	var seen []string
	var call *Call
	def, err := core.DefineCapability(t.Name(),
		Operation{Name: "read", Mode: Immediate, Args: []Shape{TextShape, Optional(NumberShape)}, Result: NumberShape, Cost: Cost{Fuel: 7, Alloc: 3}, Do: func(c *Call, args []Value) (Value, error) {
			call = c
			seen = append(seen, args[0].String())
			if err := c.Charge(5); err != nil {
				return Nothing, err
			}
			return Int(9), nil
		}},
		Operation{Name: "write", Mode: FireAndForget, Args: []Shape{NumberShape}, Cost: Cost{Fuel: 2}, Fire: func(c *Call, args []Value) error { seen = append(seen, args[0].String()); return nil }},
	)
	if err != nil {
		t.Fatal(err)
	}
	var trace lines
	g := core.NewGroup(GroupOptions{Trace: &trace})
	s, err := g.Load(LoadOptions{Name: "s", Source: "on go\nask meter to read \"x\"\ntell meter to write it\nreturn it\nend", Grants: map[string]*Grant{"meter": def.GrantAll("tenant")}})
	if err != nil {
		t.Fatal(err)
	}
	_, p, err := s.Request(context.Background(), Message{Name: "go"})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 30, 9, 0, 0, 0, time.UTC)
	result, err := g.Pump(now, PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	v, e := p.Result()
	if e != nil || !v.Equal(Int(9)) {
		t.Fatalf("%v %v; %+v", v, e, result)
	}
	if strings.Join(seen, ",") != "\"x\",9" || call.ID() != "s/r1.c1" || call.Binding() != "tenant" || call.GrantName() != "meter" || call.Group() != g || !call.Now().Equal(now) {
		t.Fatalf("%v %#v", seen, call)
	}
	if err := call.Charge(1); err == nil {
		t.Fatal("Charge accepted after return")
	}
	if !strings.Contains(strings.Join(trace, "\n"), "op=meter.read args=[\"x\"] result=9 charged=5") {
		t.Fatal(trace)
	}
}

func TestCapabilityFailuresAndPrechargeChecks(t *testing.T) {
	for _, test := range []struct {
		name      string
		cost      Cost
		arg       Shape
		result    Shape
		hostError error
		fuel      int64
		alloc     int64
		input     Value
		want      Outcome
		invoked   bool
	}{
		{name: "argument", arg: TextShape, result: NumberShape, input: Int(1), want: Errored},
		{name: "declared fuel", arg: NumberShape, result: NumberShape, cost: Cost{Fuel: 100}, fuel: 20, input: Int(1), want: LimitFault},
		{name: "declared alloc", arg: NumberShape, result: NumberShape, cost: Cost{Alloc: 100}, alloc: 20, input: Int(1), want: LimitFault},
		{name: "result", arg: NumberShape, result: TextShape, input: Int(1), want: Errored, invoked: true},
		{name: "host error", arg: NumberShape, result: NumberShape, input: Int(1), hostError: errors.New("bad host"), want: Errored, invoked: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			core := New()
			invoked := false
			d, e := core.DefineCapability(t.Name(), Operation{Name: "read", Mode: Immediate, Args: []Shape{test.arg}, Result: test.result, Cost: test.cost, Do: func(*Call, []Value) (Value, error) { invoked = true; return Int(2), test.hostError }})
			if e != nil {
				t.Fatal(e)
			}
			g := core.NewGroup(GroupOptions{})
			s, e := g.Load(LoadOptions{Name: "s", Source: "on go x\nask meter to read x\nend", Grants: map[string]*Grant{"meter": d.GrantAll(nil)}, Limits: Limits{FuelPerRun: test.fuel, AllocPerRun: test.alloc}})
			if e != nil {
				t.Fatal(e)
			}
			s.Deliver(Message{Name: "go", Args: []Value{test.input}})
			r, e := g.Pump(time.Date(2026, 9, 30, 9, 0, 0, 0, time.UTC), PumpOptions{})
			if e != nil {
				t.Fatal(e)
			}
			var end *RunEnd
			for _, report := range r.Reports {
				if x, ok := report.(*RunEnd); ok {
					end = x
					break
				}
			}
			if end == nil || end.Outcome != test.want || invoked != test.invoked {
				t.Fatalf("invoked=%v %+v", invoked, r)
			}
		})
	}
}

func TestCapabilityDeclaredAllocationIsAtomic(t *testing.T) {
	for _, mode := range []Mode{Immediate, FireAndForget} {
		t.Run(modeName(mode), func(t *testing.T) {
			core := New()
			effects := 0
			op := Operation{Name: "inspect", Mode: mode, Cost: Cost{Fuel: 7, Alloc: 100}}
			if mode == Immediate {
				op.Do = func(*Call, []Value) (Value, error) { effects++; return Nothing, nil }
			} else {
				op.Fire = func(*Call, []Value) error { effects++; return nil }
			}
			d, e := core.DefineCapability(t.Name(), op)
			if e != nil {
				t.Fatal(e)
			}
			g := core.NewGroup(GroupOptions{})
			verb := "ask"
			if mode == FireAndForget {
				verb = "tell"
			}
			s, e := g.Load(LoadOptions{Name: "s", Source: "on go\n " + verb + " service to inspect\nend go", Grants: map[string]*Grant{"service": d.GrantAll(nil)}, Limits: Limits{AllocPerRun: 20}})
			if e != nil {
				t.Fatal(e)
			}
			s.Deliver(Message{Name: "go"})
			r, e := g.Pump(time.Date(2026, 10, 4, 12, 0, 0, 0, time.UTC), PumpOptions{})
			if e != nil {
				t.Fatal(e)
			}
			end := r.Reports[0].(*RunEnd)
			if effects != 0 || r.FuelUsed != 0 || end.Alloc != 0 || end.Limit != "alloc" {
				t.Fatalf("effects %d %+v %+v", effects, r, end)
			}
		})
	}
}

func TestCallChargeAndResultConversionBoundaries(t *testing.T) {
	for _, test := range []struct {
		name               string
		fuel, alloc        int64
		swallow, panicHost bool
		want               Outcome
		wantFuel           int64
	}{
		{name: "refused Charge", fuel: 20, want: LimitFault, wantFuel: 19},
		{name: "swallowed refused Charge", fuel: 20, swallow: true, want: LimitFault, wantFuel: 19},
		{name: "result allocation", alloc: 15, swallow: true, want: LimitFault, wantFuel: 19},
		{name: "panic", panicHost: true, want: Errored, wantFuel: 18},
	} {
		t.Run(test.name, func(t *testing.T) {
			core := New()
			var trace lines
			d, e := core.DefineCapability(t.Name(), Operation{Name: "read", Mode: Immediate, Result: NumberShape, Do: func(c *Call, _ []Value) (Value, error) {
				if test.panicHost {
					panic("private Host detail")
				}
				if e := c.Charge(5); e != nil {
					return Nothing, e
				}
				if test.fuel > 0 {
					e := c.Charge(50)
					if e != nil && !test.swallow {
						return Nothing, e
					}
				}
				return Int(7), nil
			}})
			if e != nil {
				t.Fatal(e)
			}
			g := core.NewGroup(GroupOptions{Trace: &trace})
			s, e := g.Load(LoadOptions{Name: "s", Source: "on go\nask service to read\nend", Grants: map[string]*Grant{"service": d.GrantAll(nil)}, Limits: Limits{FuelPerRun: test.fuel, AllocPerRun: test.alloc}})
			if e != nil {
				t.Fatal(e)
			}
			s.Deliver(Message{Name: "go"})
			r, e := g.Pump(time.Date(2026, 10, 4, 12, 0, 0, 0, time.UTC), PumpOptions{})
			if e != nil {
				t.Fatal(e)
			}
			var end *RunEnd
			var failure *CallFailed
			for _, report := range r.Reports {
				switch x := report.(type) {
				case *RunEnd:
					end = x
				case *CallFailed:
					failure = x
				}
			}
			if end == nil || end.Outcome != test.want || end.Fuel != test.wantFuel {
				t.Fatalf("%+v %v", end, trace)
			}
			if test.panicHost && (failure == nil || !strings.Contains(failure.Detail, "private Host detail") || strings.Contains(end.Error.Data.String(), "private Host detail")) {
				t.Fatalf("%+v %+v", failure, end)
			}
			if test.fuel > 0 && strings.Contains(strings.Join(trace, "\n"), "result=7") {
				t.Fatal("failed Charge produced a result", trace)
			}
		})
	}
}

func TestCapabilityLoadChecksAndCompileCache(t *testing.T) {
	core := New()
	d, e := core.DefineCapability(t.Name(),
		Operation{Name: "read", Mode: Immediate, Args: []Shape{TextShape, Optional(NumberShape)}, Result: NumberShape, Do: func(*Call, []Value) (Value, error) { return Int(1), nil }},
		Operation{Name: "write", Mode: FireAndForget, Args: []Shape{ValueShape}, Fire: func(*Call, []Value) error { return nil }},
		Operation{Name: "fetch", Mode: Suspending, Start: func(*Call, []Value) error { return nil }},
	)
	if e != nil {
		t.Fatal(e)
	}
	for _, test := range []struct{ call, code string }{
		{"ask missing to read", "unknown operation"}, {"ask api to missing", "unknown operation"},
		{"tell api to read \"x\"", "wrong mode"}, {"ask api to write 1", "wrong mode"},
		{"ask api to read \"x\" and wait", "wrong mode"}, {"ask api to fetch", "wrong mode"},
		{"ask api to read", "wrong argument count"}, {"ask api to read 1", "wrong argument"},
		{"say 1", "unknown operation"},
	} {
		t.Run(test.call, func(t *testing.T) {
			g := core.NewGroup(GroupOptions{})
			_, e := g.Load(LoadOptions{Name: "s", Source: "on go\n" + test.call + "\nend", Grants: map[string]*Grant{"api": d.GrantAll(nil)}})
			rejected, ok := e.(*LoadError)
			if !ok || len(rejected.Diagnostics) != 1 || rejected.Diagnostics[0].Code != test.code {
				t.Fatalf("%v", e)
			}
		})
	}
	source := "on go\nask api to read \"x\"\nend"
	g := core.NewGroup(GroupOptions{})
	if _, e := g.Load(LoadOptions{Name: "s", Source: source, Grants: map[string]*Grant{"api": d.GrantAll(nil)}}); e != nil {
		t.Fatal(e)
	}
	if _, e := core.NewGroup(GroupOptions{}).Load(LoadOptions{Name: "s", Source: source}); e == nil {
		t.Fatal("compile cache bypassed changed Grants")
	}
	narrow, _ := d.Grant([]string{"write"}, nil)
	if _, e := core.NewGroup(GroupOptions{}).Load(LoadOptions{Name: "s", Source: source, Grants: map[string]*Grant{"api": narrow}}); e == nil {
		t.Fatal("compile cache bypassed changed Operation set")
	}
}

func TestGrantTrimmingRevocationAndQueuedHostInputs(t *testing.T) {
	core := New()
	var seen []string
	var queued *Script
	var ready int
	d, e := core.DefineCapability(t.Name(), Operation{Name: "read", Mode: Immediate, Args: []Shape{Optional(TextShape)}, Result: NumberShape, Do: func(c *Call, args []Value) (Value, error) {
		seen = append(seen, c.Binding().(string))
		if c.GrantName() == "a" {
			queued.Deliver(Message{Name: "other"})
			if _, e := c.Group().Load(LoadOptions{Name: "bad"}); e == nil {
				t.Fatal("worker reentry accepted")
			}
		}
		return Int(int64(len(args))), nil
	}}, Operation{Name: "unused", Mode: FireAndForget, Fire: func(*Call, []Value) error { return nil }})
	if e != nil {
		t.Fatal(e)
	}
	template := d.GrantAll("first")
	var trace lines
	g := core.NewGroup(GroupOptions{Trace: &trace, OnReady: func() { ready++ }})
	s, e := g.Load(LoadOptions{Name: "s", Grants: map[string]*Grant{"a": template, "b": d.GrantAll("second")}, GrantsAsUsed: true, Source: "script variable count=0\non go\nask a to read\nask b to read nothing\nreturn it\nend\non other\nadd 1 to count\nend\nfunction unused\nask b to read\nend"})
	if e != nil {
		t.Fatal(e)
	}
	queued = s
	grants := s.Grants()
	if strings.Join(grants["a"], ",") != "read" || strings.Join(grants["b"], ",") != "read" || !template.operations["unused"] {
		t.Fatal(grants)
	}
	grants["a"][0] = "corrupt"
	if s.Grants()["a"][0] != "read" {
		t.Fatal("Grants accessor aliases state")
	}
	s.Deliver(Message{Name: "go"})
	now := time.Date(2026, 10, 4, 12, 0, 0, 0, time.UTC)
	g.Pump(now, PumpOptions{})
	if strings.Join(seen, ",") != "first,second" || g.Inspect().Scripts[0].Vars[0].Val.String() != "0" {
		t.Fatal(seen, trace)
	}
	g.Pump(now, PumpOptions{})
	if g.Inspect().Scripts[0].Vars[0].Val.String() != "1" || ready < 2 {
		t.Fatal(trace)
	}
	s.Revoke("a")
	s.Deliver(Message{Name: "go"})
	r, e := g.Pump(now, PumpOptions{})
	if e != nil {
		t.Fatal(e)
	}
	var end *RunEnd
	for _, report := range r.Reports {
		if x, ok := report.(*RunEnd); ok {
			end = x
			break
		}
	}
	if end == nil || end.Error == nil || end.Error.Code != "capability revoked" || len(seen) != 2 || s.Grants()["a"][0] != "read" {
		t.Fatalf("%+v %v", end, trace)
	}
}

func TestCaughtRaisePrecedesLaterHostCrossing(t *testing.T) {
	for _, mode := range []Mode{Immediate, FireAndForget} {
		t.Run(modeName(mode), func(t *testing.T) {
			core := New()
			op := Operation{Name: "read", Mode: mode}
			if mode == Immediate {
				op.Do = func(*Call, []Value) (Value, error) { return Nothing, nil }
			} else {
				op.Fire = func(*Call, []Value) error { return nil }
			}
			d, e := core.DefineCapability(t.Name(), op)
			if e != nil {
				t.Fatal(e)
			}
			var trace lines
			g := core.NewGroup(GroupOptions{Trace: &trace})
			verb := "ask"
			if mode == FireAndForget {
				verb = "tell"
			}
			s, e := g.Load(LoadOptions{Name: "s", Source: "on go\ntry\nthrow \"bad\"\ncatch e\n" + verb + " api to read\nend\nend", Grants: map[string]*Grant{"api": d.GrantAll(nil)}})
			if e != nil {
				t.Fatal(e)
			}
			s.Deliver(Message{Name: "go"})
			g.Pump(time.Date(2026, 10, 4, 12, 0, 0, 0, time.UTC), PumpOptions{})
			raiseIndex, callIndex := -1, -1
			for i, line := range trace {
				if strings.HasPrefix(line, "raise ") {
					raiseIndex = i
				}
				if strings.HasPrefix(line, "call ") {
					callIndex = i
				}
			}
			if raiseIndex < 0 || callIndex < 0 || raiseIndex >= callIndex {
				t.Fatal(trace)
			}
		})
	}
}

func TestCleanupOperationHasANewSegmentID(t *testing.T) {
	for _, preempt := range []bool{false, true} {
		t.Run(fmt.Sprint(preempt), func(t *testing.T) {
			core := New()
			segment := ""
			d, e := core.DefineCapability(t.Name(), Operation{Name: "write", Mode: FireAndForget, Fire: func(c *Call, _ []Value) error { segment = c.SegmentID(); return nil }})
			if e != nil {
				t.Fatal(e)
			}
			ready := make(chan struct{}, 4)
			g := core.NewGroup(GroupOptions{OnReady: func() { ready <- struct{}{} }})
			s, e := g.Load(LoadOptions{Name: "s", Source: "on go\ntry\nwait 1 s\nfinally\ntell api to write\nend try\nend go", Grants: map[string]*Grant{"api": d.GrantAll(nil)}})
			if e != nil {
				t.Fatal(e)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			_, _, e = s.Request(ctx, Message{Name: "go"})
			if e != nil {
				t.Fatal(e)
			}
			<-ready
			now := time.Date(2026, 10, 4, 12, 0, 0, 0, time.UTC)
			options := PumpOptions{}
			if preempt {
				options.FuelSlice = 1
			}
			if _, e = g.Pump(now, options); e != nil {
				t.Fatal(e)
			}
			cancel()
			<-ready
			if _, e = g.Pump(now, PumpOptions{}); e != nil {
				t.Fatal(e)
			}
			if segment != "s/r1.s2" {
				t.Fatal(segment)
			}
		})
	}
}
