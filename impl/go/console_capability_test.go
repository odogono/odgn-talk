package northtalk

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

type consoleHost struct {
	write func(*Call, Value) error
	read  func(*Call) error
}

func (h *consoleHost) Write(c *Call, value Value) error { return h.write(c, value) }
func (h *consoleHost) Read(c *Call) error               { return h.read(c) }
func testConsoleHost() *consoleHost {
	return &consoleHost{write: func(*Call, Value) error { return nil }, read: func(*Call) error { return nil }}
}

func TestConsoleFactoryRefusesInvalidCostsAndNilImplementation(t *testing.T) {
	core := New()
	for _, costs := range []Costs{nil, {}, {"write": {}}, {"read": {}},
		{"write": {Fuel: -1}, "read": {}}, {"write": {}, "read": {Alloc: -1}},
		{"write": {Alloc: 9007199254740992}, "read": {}}, {"write": {}, "read": {Fuel: 9007199254740992}},
	} {
		def, err := core.ConsoleCapability(testConsoleHost(), costs)
		var host *HostError
		if def != nil || !errors.As(err, &host) || host.Code != InvalidValue {
			t.Fatalf("costs %v: %v, %v", costs, def, err)
		}
	}
	for _, impl := range []ConsoleImpl{nil, (*consoleHost)(nil)} {
		def, err := core.ConsoleCapability(impl, Costs{"write": {}, "read": {}})
		var host *HostError
		if def != nil || !errors.As(err, &host) || host.Code != InvalidValue {
			t.Fatalf("nil impl: %v, %v", def, err)
		}
	}
	if _, err := core.ConsoleCapability(testConsoleHost(), Costs{"write": {Fuel: 9007199254740991}, "read": {Alloc: 9007199254740991}, "ignored": {Fuel: -1}}); err != nil {
		t.Fatal(err)
	}
}

func TestConsoleFactoryLibraryWriteAndQueuedReadUseCaller(t *testing.T) {
	core := New()
	library, err := core.CompileLibrary(LibrarySource{Name: "helper", Source: "function show value\n say value\nend show\n"}, nil, GrantDecls{"console": {"write": {Mode: FireAndForget, Args: []Shape{ValueShape}}}})
	if err != nil {
		t.Fatal(err)
	}
	var writes []Value
	var calls []*Call
	var read *Call
	host := &consoleHost{
		write: func(c *Call, v Value) error { calls = append(calls, c); writes = append(writes, v); return c.Charge(5) },
		read: func(c *Call) error {
			calls = append(calls, c)
			read = c
			if err := c.Charge(3); err != nil {
				return err
			}
			c.AnswerWithCost(mustPublicText(""), 4)
			return nil
		},
	}
	costs := Costs{"write": {Fuel: 7, Alloc: 2}, "read": {Fuel: 11, Alloc: 3}}
	def, err := core.ConsoleCapability(host, costs)
	if err != nil || def.Name() != "console" {
		t.Fatalf("%v, %v", def, err)
	}
	costs["write"] = Cost{Fuel: 100000, Alloc: 100000}
	delete(costs, "read")
	var trace lines
	ready := 0
	g := core.NewGroup(GroupOptions{Trace: &trace, OnReady: func() { ready++ }})
	if err := g.AddLibrary(library); err != nil {
		t.Fatal(err)
	}
	s, err := g.Load(LoadOptions{Name: "s", Source: "use show from helper\non go\n put given x: x into callback\n show([{callback: callback}])\n ask terminal to read and wait\n say it\n return it\nend go\n", Grants: map[string]*Grant{"console": def.GrantAll("tenant"), "terminal": def.GrantAll("tenant")}, GrantsAsUsed: true, Limits: Limits{FuelPerRun: 500, AllocPerRun: 500, MaxWait: time.Millisecond}})
	if err != nil {
		t.Fatal(err)
	}
	if got := s.Grants(); len(got["console"]) != 1 || got["console"][0] != "write" || len(got["terminal"]) != 1 || got["terminal"][0] != "read" {
		t.Fatal(got)
	}
	_, p, err := s.Request(context.Background(), Message{Name: "go"})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 2, 12, 0, 0, 123456789, time.UTC)
	first, err := g.Pump(now, PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-p.Done():
		t.Fatal("read answer resumed inside starting Pump")
	default:
	}
	if len(writes) != 1 || writes[0].Index(1).Get("callback").Kind() != KindFunction {
		t.Fatal(writes)
	}
	if writes[0].String() != `[{callback: <function s:3:6>}]` {
		t.Fatal(writes[0])
	}
	if read == nil || read.ID() != "s/r1.c2" || !first.NextDeadline.Equal(now.Add(2147483647*time.Millisecond)) {
		t.Fatalf("%+v %v", first, read)
	}
	if read.Context().Err() != nil {
		t.Fatal(read.Context().Err())
	}
	if _, err = g.Pump(now, PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	value, failure := p.Result()
	if failure != nil || !value.Equal(mustPublicText("")) || len(writes) != 2 || !writes[1].Equal(value) || ready != 2 {
		t.Fatalf("%v, %v, %v, ready=%d", value, failure, writes, ready)
	}
	for i, c := range calls {
		grant := "console"
		if i == 1 {
			grant = "terminal"
		}
		if c.ScriptName() != "s" || c.RunID() != "s/r1" || c.GrantName() != grant || c.Binding() != "tenant" || c.Group() != g || !c.Now().Equal(now) {
			t.Fatalf("%+v", c)
		}
	}
	if !strings.Contains(strings.Join(trace, "\n"), "op=terminal.read args=[] charged=3") {
		t.Fatal(trace)
	}
}

func TestConsoleFactoryReadDeadlineAndCancellation(t *testing.T) {
	for _, cancel := range []bool{false, true} {
		name := "timeout"
		if cancel {
			name = "cancel"
		}
		t.Run(name, func(t *testing.T) {
			core := New()
			var read *Call
			host := testConsoleHost()
			host.read = func(c *Call) error { read = c; return nil }
			def, err := core.ConsoleCapability(host, Costs{"write": {}, "read": {}})
			if err != nil {
				t.Fatal(err)
			}
			var trace lines
			g := core.NewGroup(GroupOptions{Trace: &trace})
			s, err := g.Load(LoadOptions{Name: "s", Source: "on go\n ask input to read and wait\n return it\nend go\n", Grants: map[string]*Grant{"input": def.GrantAll(nil)}, Limits: Limits{MaxWait: time.Millisecond}})
			if err != nil {
				t.Fatal(err)
			}
			_, p, err := s.Request(context.Background(), Message{Name: "go"})
			if err != nil {
				t.Fatal(err)
			}
			now := time.Date(2026, 10, 2, 12, 0, 0, 0, time.UTC)
			first, err := g.Pump(now, PumpOptions{})
			if err != nil {
				t.Fatal(err)
			}
			deadline := now.Add(2147483647 * time.Millisecond)
			if !first.NextDeadline.Equal(deadline) {
				t.Fatal(first)
			}
			if _, err = g.Pump(deadline.Add(-time.Nanosecond), PumpOptions{}); err != nil {
				t.Fatal(err)
			}
			select {
			case <-p.Done():
				t.Fatal("read ended before deadline")
			default:
			}
			if cancel {
				s.CancelRun("s/r1")
			}
			result, err := g.Pump(deadline, PumpOptions{})
			if err != nil {
				t.Fatal(err)
			}
			end := joinEnd(t, result, "s")
			if cancel {
				if end.Outcome != Cancelled {
					t.Fatal(end)
				}
			} else if end.Error == nil || end.Error.Code != "timeout" || end.Error.Data.Get("capability").String() != `"input"` {
				t.Fatal(end)
			}
			if !errors.Is(read.Context().Err(), context.Canceled) {
				t.Fatal(read.Context().Err())
			}
			read.Answer(mustPublicText("late"))
			if _, err = g.Pump(deadline, PumpOptions{}); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(strings.Join(trace, "\n"), "note s/r1.c1 kind=late-answer") {
				t.Fatal(trace)
			}
		})
	}
}

func TestConsoleFactoryFailuresBecomeHostErrors(t *testing.T) {
	for _, name := range []string{"write failure", "read start failure", "read failure", "read invalid result", "write panic", "read panic"} {
		t.Run(name, func(t *testing.T) {
			core := New()
			var read *Call
			host := testConsoleHost()
			host.write = func(*Call, Value) error {
				if name == "write panic" {
					panic("private Host detail")
				}
				return &ScriptError{Code: "console failed"}
			}
			host.read = func(c *Call) error {
				read = c
				if name == "read panic" {
					panic("private Host detail")
				}
				if name == "read start failure" {
					return &ScriptError{Code: "console failed"}
				}
				return nil
			}
			def, err := core.ConsoleCapability(host, Costs{"write": {}, "read": {}})
			if err != nil {
				t.Fatal(err)
			}
			action := "ask terminal to read and wait"
			if strings.HasPrefix(name, "write") {
				action = `tell terminal to write "value"`
			}
			g := core.NewGroup(GroupOptions{})
			s, err := g.Load(LoadOptions{Name: "s", Source: "on go\n " + action + "\nend go\n", Grants: map[string]*Grant{"terminal": def.GrantAll(nil)}})
			if err != nil {
				t.Fatal(err)
			}
			_, err = s.Deliver(Message{Name: "go"})
			if err != nil {
				t.Fatal(err)
			}
			now := time.Date(2026, 10, 2, 12, 0, 0, 0, time.UTC)
			result, err := g.Pump(now, PumpOptions{})
			if err != nil {
				t.Fatal(err)
			}
			if name == "read failure" || name == "read invalid result" {
				if name == "read failure" {
					read.Fail(&ScriptError{Code: "console failed"})
				} else {
					read.Answer(Int(7))
				}
				result, err = g.Pump(now, PumpOptions{})
				if err != nil {
					t.Fatal(err)
				}
			}
			end := joinEnd(t, result, "s")
			if end.Outcome != Errored || end.Error == nil || end.Error.Code != "host error" || end.Error.Data.Get("capability").String() != `"terminal"` {
				t.Fatal(end)
			}
			found := false
			for _, r := range result.Reports {
				if failed, ok := r.(*CallFailed); ok {
					found = true
					if failed.Operation.Capability != "console" {
						t.Fatal(failed)
					}
				}
			}
			if !found {
				t.Fatal("Host failure report missing", result)
			}
		})
	}
}

func TestConsoleFactoryPrechargeRefusalDoesNotCallHost(t *testing.T) {
	for _, name := range []string{"write", "read"} {
		t.Run(name, func(t *testing.T) {
			core := New()
			called := false
			host := &consoleHost{write: func(*Call, Value) error { called = true; return nil }, read: func(*Call) error { called = true; return nil }}
			costs := Costs{"write": {}, "read": {}}
			limits := Limits{FuelPerRun: 20}
			limit := "fuel"
			costs[name] = Cost{Fuel: 100}
			if name == "read" {
				costs[name] = Cost{Alloc: 100}
				limits = Limits{AllocPerRun: 40}
				limit = "alloc"
			}
			def, err := core.ConsoleCapability(host, costs)
			if err != nil {
				t.Fatal(err)
			}
			action := `tell terminal to write "x"`
			if name == "read" {
				action = "ask terminal to read and wait"
			}
			g := core.NewGroup(GroupOptions{})
			s, err := g.Load(LoadOptions{Name: "s", Source: "script variable touched = 0\non go\n put 1 into touched\n " + action + "\nend go\n", Grants: map[string]*Grant{"terminal": def.GrantAll(nil)}, Limits: limits})
			if err != nil {
				t.Fatal(err)
			}
			if _, err = s.Deliver(Message{Name: "go"}); err != nil {
				t.Fatal(err)
			}
			result, err := g.Pump(time.Date(2026, 10, 2, 12, 0, 0, 0, time.UTC), PumpOptions{})
			if err != nil {
				t.Fatal(err)
			}
			end := joinEnd(t, result, "s")
			if called || end.Outcome != LimitFault || end.Limit != limit || !g.Inspect().Scripts[0].Vars[0].Val.Equal(Int(0)) {
				t.Fatalf("called=%v %+v", called, end)
			}
		})
	}
}
