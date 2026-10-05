package northtalk

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func TestObjectReadOnlyLoadAndReloadChecks(t *testing.T) {
	core := New()
	define := func(writable bool) *ObjectKind {
		prop := Prop{Name: "label", Shape: TextShape, Get: func(*Object) (Value, error) { return mustPublicText("on"), nil }}
		if writable {
			prop.Set = func(*Object, Value) error { return nil }
		}
		k, err := core.DefineObjectKind(ObjectKindDef{Name: "light", Props: []Prop{prop}})
		if err != nil {
			t.Fatal(err)
		}
		return k
	}
	writable, readonly := define(true), define(false)
	for _, target := range []string{"the label of bulb", `the "label" of bulb`, `the ("label") of bulb`, `the (("label")) of bulb`, "bulb's label", "the label of (bulb)"} {
		source := "on go\n set " + target + " to \"off\"\nend go"
		for _, kind := range []*ObjectKind{writable, readonly, writable} {
			g := core.NewGroup(GroupOptions{})
			o, _ := g.Object(kind, "bulb", nil)
			_, err := g.Load(LoadOptions{Name: "s", Source: source, Objects: map[string]*Object{"bulb": o}})
			if kind == writable {
				if err != nil {
					t.Fatal(target, err)
				}
				continue
			}
			var load *LoadError
			if !errors.As(err, &load) || len(load.Diagnostics) != 1 || load.Diagnostics[0].Code != "can't write" || load.Diagnostics[0].Line != 2 || load.Diagnostics[0].Col != 2 {
				t.Fatal(target, err)
			}
		}
	}
	g := core.NewGroup(GroupOptions{})
	o, _ := g.Object(readonly, "bulb", nil)
	s, err := g.Load(LoadOptions{Name: "s", Source: "on go\n return 1\nend go", Objects: map[string]*Object{"bulb": o}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Reload("on go\n set the label of bulb to \"off\"\nend go", CarryVariables); err == nil {
		t.Fatal("read-only Reload accepted")
	}
	s.Deliver(Message{Name: "go"})
	result, err := g.Pump(time.Date(2026, 10, 5, 8, 0, 0, 0, time.UTC), PumpOptions{})
	if err != nil || joinEnd(t, result, "s").Result.String() != "1" {
		t.Fatal(result, err)
	}
	_, err = g.Load(LoadOptions{Name: "missing", Source: "on go\n set the absent of bulb to 1\nend go", Objects: map[string]*Object{"bulb": o}})
	var load *LoadError
	if !errors.As(err, &load) || load.Diagnostics[0].Code != "can't write" {
		t.Fatal(err)
	}
}

func TestObjectDynamicWritesRemainRuntimeChecks(t *testing.T) {
	core := New()
	kind, err := core.DefineObjectKind(ObjectKindDef{Name: "light", Props: []Prop{{Name: "label", Shape: TextShape, Get: func(*Object) (Value, error) { return mustPublicText("on"), nil }}}})
	if err != nil {
		t.Fatal(err)
	}
	g := core.NewGroup(GroupOptions{})
	o, _ := g.Object(kind, "bulb", nil)
	s, err := g.Load(LoadOptions{Name: "s", Objects: map[string]*Object{"bulb": o}, Source: `on go k
 try
  set the (k) of bulb to "off"
 catch e
  return the code of e
 end try
end go
on alias o
 try
  set the label of o to "off"
 catch e
  return the code of e
 end try
end alias`})
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range []Message{{Name: "go", Args: []Value{mustPublicText("label")}}, {Name: "alias", Args: []Value{o.Value()}}} {
		s.Deliver(m)
		result, err := g.Pump(time.Date(2026, 10, 5, 8, 0, 0, 0, time.UTC), PumpOptions{})
		if err != nil || joinEnd(t, result, "s").Result.String() != `"read only"` {
			t.Fatal(result, err)
		}
	}
}

func TestObjectDynamicGuardKeysSkipWithoutHostCalls(t *testing.T) {
	core := New()
	calls := 0
	kind, err := core.DefineObjectKind(ObjectKindDef{Name: "light", Props: []Prop{{Name: "label", Shape: TextShape, Get: func(*Object) (Value, error) { calls++; return mustPublicText("on"), nil }}}})
	if err != nil {
		t.Fatal(err)
	}
	for _, expr := range []string{"the label of o", `the "label" of o`, `the "length" of o`, "the (k) of o"} {
		var trace lines
		g := core.NewGroup(GroupOptions{Trace: &trace})
		o, _ := g.Object(kind, "bulb", nil)
		s, err := g.Load(LoadOptions{Name: "s", Source: "on go o, k where " + expr + " = \"on\"\n return 1\nend go\non go o, k\n return 2\nend go"})
		if err != nil {
			t.Fatal(err)
		}
		for _, input := range []Value{localeMap(t, KV("label", mustPublicText("on")), KV("length", mustPublicText("on"))), o.Value()} {
			s.Deliver(Message{Name: "go", Args: []Value{input, mustPublicText("label")}})
			result, err := g.Pump(time.Date(2026, 10, 5, 8, 0, 0, 0, time.UTC), PumpOptions{})
			want := "1"
			if input.Equal(o.Value()) {
				want = "2"
			}
			if err != nil || joinEnd(t, result, "s").Result.String() != want {
				t.Fatal(expr, result, err)
			}
		}
		if !strings.Contains(strings.Join(trace, "\n"), `guard-skip s/r2 at=`) || !strings.Contains(strings.Join(trace, "\n"), `code="wrong kind"`) || calls != 0 {
			t.Fatal(expr, trace, calls)
		}
	}
}

func TestObjectKnownComputedGuardKeysCheckAtLoad(t *testing.T) {
	core := New()
	g := core.NewGroup(GroupOptions{})
	o, _ := g.Object(objectKindForTest(t, core, "light"), "bulb", nil)
	for _, expr := range []string{"the (k) of bulb", `the ("label") of bulb`, `the (("label")) of bulb`, "the label of the target", "the (k) of me", "the label of (bulb)", "the label of (me)", `the "length" of bulb`, "the label of (the target)"} {
		_, err := g.Load(LoadOptions{Name: "s", Objects: map[string]*Object{"bulb": o}, Source: "on go k where " + expr + " = \"on\"\nend go"})
		var load *LoadError
		if !errors.As(err, &load) || load.Diagnostics[0].Code != "not in a guard" {
			t.Fatal(expr, err)
		}
	}
	if _, err := g.Load(LoadOptions{Name: "id", Objects: map[string]*Object{"bulb": o}, Source: `on go where the (("id")) of bulb = "bulb"
end go`}); err != nil {
		t.Fatal(err)
	}

}
