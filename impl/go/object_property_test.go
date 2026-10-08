package northtalk

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func TestObjectPropertiesReadWriteAndDispose(t *testing.T) {
	core := New()
	native := mustPublicText("off")
	gets, sets := 0, 0
	kind, err := core.DefineObjectKind(ObjectKindDef{Name: "light", Props: []Prop{
		{Name: "label", Shape: TextShape, GetCost: Cost{Fuel: 2}, SetCost: Cost{Fuel: 5},
			Get: func(o *Object) (Value, error) { gets++; return *o.Native().(*Value), nil },
			Set: func(o *Object, v Value) error { sets++; *o.Native().(*Value) = v; return nil }},
		{Name: "watts", Shape: NumberShape, Get: func(*Object) (Value, error) { return Int(60), nil }},
	}})
	if err != nil {
		t.Fatal(err)
	}
	var trace lines
	g := core.NewGroup(GroupOptions{Trace: &trace})
	o, err := g.Object(kind, "bulb", &native)
	if err != nil {
		t.Fatal(err)
	}
	s, err := g.Load(LoadOptions{Name: "s", Objects: map[string]*Object{"bulb": o}, Source: `on go k
 put [the label of bulb, the "watts" of bulb, the absent of bulb] into before
 set the (k) of bulb to "on"
 return [before, the (k) of bulb, the id of bulb]
end go
on later k
 try
  return the (k) of bulb
 catch e
  return [the code of e, the object of e]
 end try
end later`})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 4, 21, 0, 0, 0, time.UTC)
	s.Deliver(Message{Name: "go", Args: []Value{mustPublicText("label")}})
	result, err := g.Pump(now, PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if end := joinEnd(t, result, "s"); end.Outcome != Completed || end.Result.String() != `[["off", 60, nothing], "on", "bulb"]` || gets != 2 || sets != 1 || native.String() != `"on"` {
		t.Fatal(end, gets, sets, native, trace)
	}
	g.Dispose(o)
	s.Deliver(Message{Name: "later", Args: []Value{mustPublicText("absent")}})
	result, err = g.Pump(now, PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if end := joinEnd(t, result, "s"); end.Result.String() != `["object gone", <object light "bulb">]` || gets != 2 {
		t.Fatal(end, gets)
	}
	if !strings.Contains(strings.Join(trace, "\n"), `prop s/r1 object=<object light "bulb"> name=label op=set value="on"`) {
		t.Fatal(trace)
	}
}

func TestObjectPropertyFailures(t *testing.T) {
	for _, test := range []struct {
		name, code string
		get        func(*Object) (Value, error)
	}{
		{"wrong result", "host error", func(*Object) (Value, error) { return Int(1), nil }},
		{"panic", "host error", func(*Object) (Value, error) { panic("Host secret") }},
		{"ordinary error", "host error", func(*Object) (Value, error) { return Nothing, errors.New("Host secret") }},
		{"custom error", "lamp broken", func(*Object) (Value, error) { return Nothing, &ScriptError{Code: "lamp broken", Message: "broken"} }},
		{"catalogue error", "host error", func(*Object) (Value, error) { return Nothing, &ScriptError{Code: "object gone"} }},
		{"invalid failure text", "host error", func(*Object) (Value, error) { return Nothing, &ScriptError{Code: "\xff"} }},
		{"non-map failure Data", "host error", func(*Object) (Value, error) { return Nothing, &ScriptError{Code: "lamp broken", Data: Int(123)} }},
		{"text failure Data", "host error", func(*Object) (Value, error) {
			return Nothing, &ScriptError{Code: "lamp broken", Message: "Host secret", Data: mustPublicText("private payload")}
		}},
		{"list failure Data", "host error", func(*Object) (Value, error) {
			return Nothing, &ScriptError{Code: "lamp broken", Data: List(Int(1))}
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			core := New()
			kind, err := core.DefineObjectKind(ObjectKindDef{Name: "light", Props: []Prop{{Name: "label", Shape: TextShape, Get: test.get}}})
			if err != nil {
				t.Fatal(err)
			}
			var trace lines
			g := core.NewGroup(GroupOptions{Trace: &trace})
			o, _ := g.Object(kind, "bulb", nil)
			s, err := g.Load(LoadOptions{Name: "s", Objects: map[string]*Object{"bulb": o}, Source: `on go
 try
  return the label of bulb
 catch e
  return [the code of e, the capability of e, the operation of e]
 end try
end go`})
			if err != nil {
				t.Fatal(err)
			}
			s.Deliver(Message{Name: "go"})
			result, err := g.Pump(time.Date(2026, 10, 4, 21, 0, 0, 0, time.UTC), PumpOptions{})
			if err != nil {
				t.Fatal(err)
			}
			want := `["` + test.code + `", "light", "label"]`
			if end := joinEnd(t, result, "s"); end.Result.String() != want {
				t.Fatal(end, trace)
			}
			if strings.Contains(strings.Join(trace, "\n"), "Host secret") {
				t.Fatal(trace)
			}
			if test.code == "host error" {
				failures := 0
				for _, report := range operationalReports(result.Reports) {
					if failure, ok := report.(*CallFailed); ok {
						failures++
						if failure.Call != "" || failure.Script != "s" || failure.Operation != (OperationRef{Capability: "light", Operation: "label"}) || failure.Detail == "" {
							t.Fatal(failure)
						}
					}
				}
				if failures != 1 {
					t.Fatal("missing property failure detail", operationalReports(result.Reports))
				}
			}
		})
	}
}

func TestObjectPropertyPreHostCostFaults(t *testing.T) {
	for _, test := range []struct {
		name   string
		cost   Cost
		limits Limits
		code   Outcome
	}{
		{"fuel", Cost{Fuel: 100}, Limits{FuelPerRun: 30}, LimitFault},
		{"allocation", Cost{Alloc: 100}, Limits{AllocPerRun: 40}, LimitFault},
	} {
		t.Run(test.name, func(t *testing.T) {
			core := New()
			calls := 0
			kind, err := core.DefineObjectKind(ObjectKindDef{Name: "light", Props: []Prop{{Name: "label", Shape: TextShape, GetCost: test.cost, Get: func(*Object) (Value, error) { calls++; return mustPublicText("off"), nil }}}})
			if err != nil {
				t.Fatal(err)
			}
			g := core.NewGroup(GroupOptions{})
			o, _ := g.Object(kind, "bulb", nil)
			s, err := g.Load(LoadOptions{Name: "s", Limits: test.limits, Objects: map[string]*Object{"bulb": o}, Source: "on go\n return the label of bulb\nend go"})
			if err != nil {
				t.Fatal(err)
			}
			s.Deliver(Message{Name: "go"})
			result, err := g.Pump(time.Date(2026, 10, 4, 21, 0, 0, 0, time.UTC), PumpOptions{})
			if err != nil {
				t.Fatal(err)
			}
			if end := joinEnd(t, result, "s"); end.Outcome != test.code || calls != 0 || end.Fuel != 5 {
				t.Fatal(end, calls)
			}
		})
	}
}

func TestObjectPropertyGuardCannotCallHost(t *testing.T) {
	core := New()
	calls := 0
	kind, err := core.DefineObjectKind(ObjectKindDef{Name: "light", Props: []Prop{{Name: "label", Shape: TextShape, Get: func(*Object) (Value, error) { calls++; return mustPublicText("on"), nil }}}})
	if err != nil {
		t.Fatal(err)
	}
	g := core.NewGroup(GroupOptions{})
	o, _ := g.Object(kind, "bulb", nil)
	for _, expr := range []string{"the label of bulb", `the "label" of bulb`, `the ("label") of bulb`} {
		_, err := g.Load(LoadOptions{Name: "s", Objects: map[string]*Object{"bulb": o}, Source: "on go where " + expr + " = \"on\"\nend go"})
		var load *LoadError
		if !errors.As(err, &load) || len(load.Diagnostics) != 1 || load.Diagnostics[0].Code != "not in a guard" {
			t.Fatal(expr, err)
		}
	}
	if calls != 0 {
		t.Fatal(calls)
	}
}

func TestObjectPropertyResultsAndFailuresCheckGroup(t *testing.T) {
	for _, mode := range []string{"result", "failure map", "failure object"} {
		core := New()
		foreignGroup := core.NewGroup(GroupOptions{})
		foreign, _ := foreignGroup.Object(objectKindForTest(t, core, "foreign"), "key", nil)
		nested := List(localeMap(t, KV("object", foreign.Value())))
		prop := Prop{Name: "label", Shape: AnyShape, Get: func(*Object) (Value, error) {
			if mode == "failure map" {
				return Nothing, &ScriptError{Code: "lamp broken", Data: localeMap(t, KV("payload", nested))}
			}
			if mode == "failure object" {
				return Nothing, &ScriptError{Code: "lamp broken", Data: foreign.Value()}
			}
			return nested, nil
		}}
		kind, err := core.DefineObjectKind(ObjectKindDef{Name: "light", Props: []Prop{prop}})
		if err != nil {
			t.Fatal(err)
		}
		g := core.NewGroup(GroupOptions{})
		o, _ := g.Object(kind, "bulb", nil)
		s, err := g.Load(LoadOptions{Name: "s", Objects: map[string]*Object{"bulb": o}, Source: "on go\n return the label of bulb\nend go"})
		if err != nil {
			t.Fatal(err)
		}
		s.Deliver(Message{Name: "go"})
		result, err := g.Pump(time.Date(2026, 10, 4, 21, 0, 0, 0, time.UTC), PumpOptions{})
		if err != nil {
			t.Fatal(err)
		}
		end := joinEnd(t, result, "s")
		if end.Outcome != Errored || end.Error == nil || end.Error.Code != "host error" {
			t.Fatal(mode, end)
		}
	}
}

func TestObjectPropertyConversionFaultKeepsHostEffect(t *testing.T) {
	core := New()
	calls := 0
	kind, err := core.DefineObjectKind(ObjectKindDef{Name: "light", Props: []Prop{{Name: "label", Shape: TextShape, Get: func(*Object) (Value, error) { calls++; return mustPublicText("on"), nil }}}})
	if err != nil {
		t.Fatal(err)
	}
	var trace lines
	g := core.NewGroup(GroupOptions{Trace: &trace})
	o, _ := g.Object(kind, "bulb", nil)
	s, err := g.Load(LoadOptions{Name: "s", Limits: Limits{AllocPerRun: 15}, Objects: map[string]*Object{"bulb": o}, Source: "script variable n = 0\non go\n put 1 into n\n return the label of bulb\nend go"})
	if err != nil {
		t.Fatal(err)
	}
	s.Deliver(Message{Name: "go"})
	result, err := g.Pump(time.Date(2026, 10, 4, 21, 0, 0, 0, time.UTC), PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	end := joinEnd(t, result, "s")
	if end.Outcome != LimitFault || end.Limit != "alloc" || end.Alloc != 0 || calls != 1 || g.Inspect().Scripts[0].Vars[0].Val.String() != "0" {
		t.Fatal(end, calls, g.Inspect())
	}
	if !strings.Contains(strings.Join(trace, "\n"), `name=label op=get value="on"`) {
		t.Fatal(trace)
	}
}

func TestObjectPropertySetEffectsAndCancelAtCrossing(t *testing.T) {
	core := New()
	writes := 0
	var g *Group
	var script *Script
	prop := Prop{Name: "label", Shape: TextShape, Get: func(*Object) (Value, error) { return mustPublicText("off"), nil }, Set: func(*Object, Value) error { writes++; script.CancelRun("s/r1"); return nil }}
	kind, err := core.DefineObjectKind(ObjectKindDef{Name: "light", Props: []Prop{prop}})
	if err != nil {
		t.Fatal(err)
	}
	var trace lines
	g = core.NewGroup(GroupOptions{Trace: &trace})
	o, _ := g.Object(kind, "bulb", nil)
	s, err := g.Load(LoadOptions{Name: "s", Objects: map[string]*Object{"bulb": o}, Source: `script variable n = 0
on go
 try
  put 1 into n
  set the label of bulb to "on"
  put 2 into n
 finally
  put 3 into n
 end try
end go`})
	if err != nil {
		t.Fatal(err)
	}
	script = s
	s.Deliver(Message{Name: "go"})
	result, err := g.Pump(time.Date(2026, 10, 4, 21, 0, 0, 0, time.UTC), PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if end := joinEnd(t, result, "s"); end.Outcome != Cancelled || writes != 1 || g.Inspect().Scripts[0].Vars[0].Val.String() != "3" {
		t.Fatal(end, writes, g.Inspect(), trace)
	}
	propAt := -1
	cancelAt := -1
	for i, line := range trace {
		if strings.HasPrefix(line, "prop ") {
			propAt = i
		}
		if strings.HasPrefix(line, "> cancel-run") {
			cancelAt = i
		}
	}
	if propAt < 0 || cancelAt <= propAt {
		t.Fatal(trace)
	}
}

func TestObjectPropertyGuardIdentityAndDynamicBoundary(t *testing.T) {
	core := New()
	calls := 0
	kind, err := core.DefineObjectKind(ObjectKindDef{Name: "light", Props: []Prop{{Name: "label", Shape: TextShape, Get: func(*Object) (Value, error) { calls++; return mustPublicText("on"), nil }}}})
	if err != nil {
		t.Fatal(err)
	}
	for _, expr := range []string{"the id of bulb", `the "id" of bulb`, `the ("id") of bulb`} {
		g := core.NewGroup(GroupOptions{})
		o, _ := g.Object(kind, "bulb", nil)
		s, err := g.Load(LoadOptions{Name: "s", Objects: map[string]*Object{"bulb": o}, Source: "on go where " + expr + " = \"bulb\"\n return 1\nend go"})
		if err != nil {
			t.Fatal(expr, err)
		}
		s.Deliver(Message{Name: "go"})
		result, err := g.Pump(time.Date(2026, 10, 4, 21, 0, 0, 0, time.UTC), PumpOptions{})
		if err != nil {
			t.Fatal(err)
		}
		if end := joinEnd(t, result, "s"); end.Result.String() != "1" {
			t.Fatal(expr, end)
		}
	}
	g := core.NewGroup(GroupOptions{})
	o, _ := g.Object(kind, "bulb", nil)
	s, err := g.Load(LoadOptions{Name: "s", Source: "on go o where the label of o = \"on\"\n return 1\nend go\non go o\n return 2\nend go"})
	if err != nil {
		t.Fatal(err)
	}
	s.Deliver(Message{Name: "go", Args: []Value{o.Value()}})
	result, err := g.Pump(time.Date(2026, 10, 4, 21, 0, 0, 0, time.UTC), PumpOptions{})
	if err != nil || calls != 0 || joinEnd(t, result, "s").Result.String() != "2" {
		t.Fatal(result, err, calls)
	}
}

func TestObjectPropertyReservedFailureDataKeepsValidTrace(t *testing.T) {
	core := New()
	data := localeMap(t, KV("code", mustPublicText("replacement")))
	kind, err := core.DefineObjectKind(ObjectKindDef{Name: "light", Props: []Prop{{Name: "label", Shape: TextShape, Get: func(*Object) (Value, error) { return Nothing, &ScriptError{Code: "lamp broken", Data: data} }}}})
	if err != nil {
		t.Fatal(err)
	}
	var trace lines
	g := core.NewGroup(GroupOptions{Trace: &trace})
	o, _ := g.Object(kind, "bulb", nil)
	s, err := g.Load(LoadOptions{Name: "s", Objects: map[string]*Object{"bulb": o}, Source: "on go\n return the label of bulb\nend go"})
	if err != nil {
		t.Fatal(err)
	}
	s.Deliver(Message{Name: "go"})
	result, err := g.Pump(time.Date(2026, 10, 4, 21, 0, 0, 0, time.UTC), PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	end := joinEnd(t, result, "s")
	if end.Outcome != Errored || end.Error == nil || end.Error.Code != "host error" {
		t.Fatal(end)
	}
	if !strings.Contains(strings.Join(trace, "\n"), `name=label op=get error={}`) {
		t.Fatal("malformed failure must keep an Error map in the Trace", trace)
	}
}
