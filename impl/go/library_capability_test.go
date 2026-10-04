package northtalk

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestLibraryImportRechecksCallerDeclarationsIncludingCachedCode(t *testing.T) {
	c := New()
	base, err := c.CompileLibrary(LibrarySource{Name: "base", Source: "private function hidden\n ask io to write \"x\"\n return it\nend hidden\nfunction fetch\n ask io to read 42\n ask io to read 43\n return it\nend fetch\n"}, nil, GrantDecls{"io": {"read": {Mode: Immediate, Args: []Shape{NumberShape}}, "write": {Mode: Immediate, Args: []Shape{TextShape}}}})
	if err != nil {
		t.Fatal(err)
	}
	wrapper, err := c.CompileLibrary(LibrarySource{Name: "wrapper", Source: "use fetch from base\nfunction run\n return fetch()\nend run\n"}, []*Library{base}, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name    string
		mode    Mode
		args    []Shape
		missing bool
		want    string
		count   int
	}{
		{name: "missing", missing: true, want: "missing grant", count: 2},
		{name: "valid", mode: Immediate, args: []Shape{NumberShape}},
		{name: "cached shape mismatch", mode: Immediate, args: []Shape{TextShape}, want: "wrong argument", count: 2},
		{name: "cached arity mismatch", mode: Immediate, args: []Shape{NumberShape, NumberShape}, want: "wrong argument count", count: 2},
		{name: "cached mode mismatch", mode: Suspending, args: []Shape{NumberShape}, want: "wrong mode", count: 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			g := c.NewGroup(GroupOptions{})
			for _, l := range []*Library{base, wrapper} {
				if err := g.AddLibrary(l); err != nil {
					t.Fatal(err)
				}
			}
			grants := map[string]*Grant{}
			if !tc.missing {
				read := Operation{Name: "read", Mode: tc.mode, Args: tc.args, Result: NumberShape}
				if tc.mode == Suspending {
					read.Start = func(*Call, []Value) error { return nil }
				} else {
					read.Do = func(*Call, []Value) (Value, error) { return Int(1), nil }
				}
				def, err := c.DefineCapability(tc.name, read, Operation{Name: "write", Mode: Immediate, Args: []Shape{TextShape}, Result: NumberShape, Do: func(*Call, []Value) (Value, error) { return Int(1), nil }})
				if err != nil {
					t.Fatal(err)
				}
				grants["io"] = def.GrantAll(nil)
			}
			_, err := g.Load(LoadOptions{Name: "s", Source: "use run from wrapper as work\non go\n return work()\nend go\n", Grants: grants})
			if tc.want == "" {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			rejected, ok := err.(*LoadError)
			if !ok {
				t.Fatalf("want LoadError, got %v", err)
			}
			if len(rejected.Diagnostics) != tc.count {
				t.Fatal(rejected.Diagnostics)
			}
			for _, d := range rejected.Diagnostics {
				if d.Code != tc.want || d.Unit != "s" || d.Line != 1 || d.Col != 1 || !strings.Contains(d.Message, "base:") {
					t.Fatal(d)
				}
			}
			if tc.missing && !strings.Contains(rejected.Diagnostics[0].Message, "io.write at base:2:2") {
				t.Fatal("missing uses did not retain first direct site:", rejected.Diagnostics)
			}
		})
	}
}

func TestLibraryCapabilitiesUseCallerBindingAndTransitiveGrantTrimming(t *testing.T) {
	c := New()
	source := LibrarySource{Name: "base", Source: "private function unused\n tell io to note \"unused\"\nend unused\nfunction fetch\n ask io to read 2\n return it\nend fetch\n"}
	base, err := c.CompileLibrary(source, nil, GrantDecls{"io": {"read": {Mode: Immediate, Args: []Shape{NumberShape}}, "note": {Mode: FireAndForget, Args: []Shape{TextShape}}}})
	if err != nil {
		t.Fatal(err)
	}
	top, err := c.CompileLibrary(LibrarySource{Name: "top", Source: "use fetch from base\nfunction run\n return fetch()\nend run\n"}, []*Library{base}, nil)
	if err != nil {
		t.Fatal(err)
	}
	var bindings []any
	def, err := c.DefineCapability("hostAPI", Operation{Name: "read", Mode: Immediate, Args: []Shape{NumberShape}, Result: NumberShape, Cost: Cost{Fuel: 7}, Do: func(call *Call, args []Value) (Value, error) {
		bindings = append(bindings, call.Binding())
		return args[0], nil
	}}, Operation{Name: "note", Mode: FireAndForget, Args: []Shape{TextShape}, Fire: func(*Call, []Value) error { return nil }}, Operation{Name: "extra", Mode: Immediate, Result: NumberShape, Do: func(*Call, []Value) (Value, error) { return Int(99), nil }})
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"a", "b"} {
		g := c.NewGroup(GroupOptions{})
		for _, l := range []*Library{base, top} {
			if err := g.AddLibrary(l); err != nil {
				t.Fatal(err)
			}
		}
		s, err := g.Load(LoadOptions{Name: name, Source: "use run from top\non go\n return run()\nend go\n", Grants: map[string]*Grant{"io": def.GrantAll(name)}, GrantsAsUsed: true})
		if err != nil {
			t.Fatal(err)
		}
		kept := s.Grants()["io"]
		if len(kept) != 2 || kept[0] != "note" || kept[1] != "read" {
			t.Fatal("trimmed transitive/private needs:", s.Grants())
		}
		_, p, err := s.Request(context.Background(), Message{Name: "go"})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := g.Pump(time.Unix(0, 0), PumpOptions{}); err != nil {
			t.Fatal(err)
		}
		select {
		case <-p.Done():
		default:
			t.Fatal("Library Capability call blocked")
		}
		v, failure := p.Result()
		if failure != nil || !v.Equal(Int(2)) {
			t.Fatal(v, failure)
		}
	}
	if len(bindings) != 2 || bindings[0] != "a" || bindings[1] != "b" {
		t.Fatal(bindings)
	}
}

func TestLibrarySuspensionCancellationRunsLibraryCleanupWithCallerGrant(t *testing.T) {
	c := New()
	var calls []*Call
	cleaned := 0
	def, err := c.DefineCapability("host", Operation{Name: "pause", Mode: Suspending, Result: NumberShape, Start: func(call *Call, _ []Value) error { calls = append(calls, call); return nil }}, Operation{Name: "clean", Mode: FireAndForget, Fire: func(call *Call, _ []Value) error {
		if call.Binding() != "caller" {
			t.Fatal(call.Binding())
		}
		cleaned++
		return nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	l, err := c.CompileLibrary(LibrarySource{Name: "helper", Source: "on hold\n try\n  ask io to pause and wait\n  return it\n finally\n  tell io to clean\n end try\nend hold\n"}, nil, GrantDecls{"io": {"pause": {Mode: Suspending}, "clean": {Mode: FireAndForget}}})
	if err != nil {
		t.Fatal(err)
	}
	g := c.NewGroup(GroupOptions{})
	if err := g.AddLibrary(l); err != nil {
		t.Fatal(err)
	}
	s, err := g.Load(LoadOptions{Name: "s", Source: "use hold from helper\non go\n hold and wait\n return it\nend go\n", Grants: map[string]*Grant{"io": def.GrantAll("caller")}, GrantsAsUsed: true})
	if err != nil {
		t.Fatal(err)
	}
	s.Deliver(Message{Name: "go"})
	joinPump(t, g, 0, PumpOptions{})
	if len(calls) != 1 || calls[0].ID() != "s/r1.c1" {
		t.Fatal(calls)
	}
	s.CancelRun("s/r1")
	end := joinEnd(t, joinPump(t, g, 1, PumpOptions{}), "s")
	if end.Outcome != Cancelled || cleaned != 1 {
		t.Fatal(end, cleaned)
	}
	for _, call := range calls {
		if call.Context().Err() == nil {
			t.Fatal("cancel retained Library pending call")
		}
	}
	calls[0].Answer(Int(2))
	joinPump(t, g, 2, PumpOptions{})
	if cleaned != 1 || s.Counters().Runs != 1 {
		t.Fatal("late Library answer resumed cancelled Run")
	}
}

func TestLibraryReloadNeedsCheckPreservesPendingCallAndRevocation(t *testing.T) {
	c := New()
	var call *Call
	reads := 0
	def, err := c.DefineCapability("host", Operation{Name: "pause", Mode: Suspending, Result: NumberShape, Start: func(c *Call, _ []Value) error { call = c; return nil }}, Operation{Name: "read", Mode: Immediate, Result: NumberShape, Do: func(*Call, []Value) (Value, error) { reads++; return Int(3), nil }})
	if err != nil {
		t.Fatal(err)
	}
	l, err := c.CompileLibrary(LibrarySource{Name: "helper", Source: "on hold\n ask io to pause and wait\n ask io to read\n return it\nend hold\n"}, nil, GrantDecls{"io": {"pause": {Mode: Suspending}, "read": {Mode: Immediate}}})
	if err != nil {
		t.Fatal(err)
	}
	missing, err := c.CompileLibrary(LibrarySource{Name: "other", Source: "function absent\n ask extra to read\n return it\nend absent\n"}, nil, GrantDecls{"extra": {"read": {Mode: Immediate}}})
	if err != nil {
		t.Fatal(err)
	}
	g := c.NewGroup(GroupOptions{})
	for _, lib := range []*Library{l, missing} {
		if err := g.AddLibrary(lib); err != nil {
			t.Fatal(err)
		}
	}
	source := "use hold from helper\non go\n hold and wait\n return it\nend go\n"
	s, err := g.Load(LoadOptions{Name: "s", Source: source, Grants: map[string]*Grant{"io": def.GrantAll(nil)}})
	if err != nil {
		t.Fatal(err)
	}
	s.Deliver(Message{Name: "go"})
	joinPump(t, g, 0, PumpOptions{})
	if call == nil {
		t.Fatal("Library did not suspend")
	}
	if _, err := s.Reload("use absent from other\non go\n return absent()\nend go\n", ResetVariables); err == nil || call.Context().Err() != nil {
		t.Fatal("rejected needs check discarded pending call:", err)
	}
	s.Revoke("io")
	joinPump(t, g, 1, PumpOptions{})
	if _, err := s.Reload(source, ResetVariables); err == nil {
		t.Fatal("cached import ignored revoked Grant")
	}
	if call.Context().Err() != nil {
		t.Fatal("rejected Reload discarded live Library call")
	}
	call.Answer(Int(2))
	end := joinEnd(t, joinPump(t, g, 2, PumpOptions{}), "s")
	if reads != 0 || end.Error == nil || end.Error.Code != "capability revoked" || end.Error.Data.Get("at").Get("unit").String() != `"helper"` {
		t.Fatal(end, reads)
	}
}

func TestLibraryDeclaredCostFaultDoesNotEnterHostAndRollsBackCaller(t *testing.T) {
	c := New()
	entered := false
	def, err := c.DefineCapability("host", Operation{Name: "read", Mode: Immediate, Result: NumberShape, Cost: Cost{Alloc: 100}, Do: func(*Call, []Value) (Value, error) { entered = true; return Int(9), nil }})
	if err != nil {
		t.Fatal(err)
	}
	l, err := c.CompileLibrary(LibrarySource{Name: "helper", Source: "function read\n ask io to read\n return it\nend read\n"}, nil, GrantDecls{"io": {"read": {Mode: Immediate}}})
	if err != nil {
		t.Fatal(err)
	}
	g := c.NewGroup(GroupOptions{})
	if err := g.AddLibrary(l); err != nil {
		t.Fatal(err)
	}
	s, err := g.Load(LoadOptions{Name: "s", Source: "use read from helper\nscript variable n = 0\non go\n put 1 into n\n return read()\nend go\n", Grants: map[string]*Grant{"io": def.GrantAll(nil)}, Limits: Limits{AllocPerRun: 20}})
	if err != nil {
		t.Fatal(err)
	}
	s.Deliver(Message{Name: "go"})
	end := joinEnd(t, joinPump(t, g, 0, PumpOptions{}), "s")
	if entered || end.Outcome != LimitFault || end.Limit != "alloc" || end.At.Unit != "helper" || g.Inspect().Scripts[0].Vars[0].Val.String() != "0" {
		t.Fatal(end, entered)
	}
}

func TestLibraryRejectsJoinAsWaitFor(t *testing.T) {
	_, err := New().CompileLibrary(LibrarySource{Name: "helper", Source: "on hold\n wait for all\n  ask io to pause and wait\n end wait\nend hold\n"}, nil, GrantDecls{"io": {"pause": {Mode: Suspending}}})
	rejected, ok := err.(*LoadError)
	if !ok {
		t.Fatalf("Library Join accepted: %v", err)
	}
	for _, d := range rejected.Diagnostics {
		if d.Code == "not in a library" && d.Line == 2 && d.Col == 2 {
			return
		}
	}
	t.Fatal(rejected.Diagnostics)
}

func TestLibraryDiamondNeedsCheckEachOriginalSiteOncePerUse(t *testing.T) {
	c := New()
	compile := func(name, source string, imports ...*Library) *Library {
		t.Helper()
		l, err := c.CompileLibrary(LibrarySource{Name: name, Source: source}, imports, GrantDecls{"io": {"read": {Mode: Immediate, Args: []Shape{NumberShape}}}})
		if err != nil {
			t.Fatal(err)
		}
		return l
	}
	base := compile("base", "function fetch\n ask io to read 1\n return it\nend fetch\n")
	left := compile("left", "use fetch from base\nfunction l\n return fetch()\nend l\n", base)
	right := compile("right", "use fetch from base\nfunction r\n return fetch()\nend r\n", base)
	top := compile("top", "use l from left\nuse r from right\nprivate function unused\n ask io to read 99\n return it\nend unused\nfunction run\n return [l(),r()]\nend run\n", left, right)
	def, err := c.DefineCapability("host", Operation{Name: "read", Mode: Immediate, Args: []Shape{TextShape}, Result: NumberShape, Do: func(*Call, []Value) (Value, error) { return Int(1), nil }})
	if err != nil {
		t.Fatal(err)
	}
	for _, grants := range []map[string]*Grant{nil, {"io": def.GrantAll(nil)}} {
		g := c.NewGroup(GroupOptions{})
		for _, l := range []*Library{base, left, right, top} {
			if err := g.AddLibrary(l); err != nil {
				t.Fatal(err)
			}
		}
		_, err := g.Load(LoadOptions{Name: "s", Source: "use run from top\nuse run from top as again\n", Grants: grants})
		rejected, ok := err.(*LoadError)
		if !ok {
			t.Fatal(err)
		}
		want := 2
		if grants != nil {
			want = 4
		}
		if len(rejected.Diagnostics) != want {
			t.Fatal("diamond duplicate or per-use diagnostics lost:", rejected.Diagnostics)
		}
		if grants == nil {
			for j, d := range rejected.Diagnostics {
				if d.Line != j+1 || !strings.Contains(d.Message, "top:4:2") {
					t.Fatal("first direct site order:", d)
				}
			}
		}
	}
}
