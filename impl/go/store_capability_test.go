package northtalk

import (
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
)

type storeHost struct {
	invoke func(string, *Call, []Value) (Value, error)
	effect func(string, SegmentContext) EffectResult
}

func (s *storeHost) Begin(c SegmentContext) EffectResult    { return s.effect("begin", c) }
func (s *storeHost) Commit(c SegmentContext) EffectResult   { return s.effect("commit", c) }
func (s *storeHost) Rollback(c SegmentContext) EffectResult { return s.effect("rollback", c) }
func (s *storeHost) Get(c *Call, k string, fallback Value) (Value, error) {
	return s.invoke("get", c, []Value{mustPublicText(k), fallback})
}
func (s *storeHost) Set(c *Call, k string, v Value) error {
	_, err := s.invoke("set", c, []Value{mustPublicText(k), v})
	return err
}
func (s *storeHost) Delete(c *Call, k string) error {
	_, err := s.invoke("delete", c, []Value{mustPublicText(k)})
	return err
}
func (s *storeHost) Keys(c *Call, prefix string) (Value, error) {
	return s.invoke("keys", c, []Value{mustPublicText(prefix)})
}
func (s *storeHost) Increment(c *Call, k string, by Value) (Value, error) {
	return s.invoke("increment", c, []Value{mustPublicText(k), by})
}
func (s *storeHost) Swap(c *Call, k string, expected, replacement Value) (bool, error) {
	v, err := s.invoke("swap", c, []Value{mustPublicText(k), expected, replacement})
	b, _ := v.AsBool()
	return b, err
}
func storeCosts() Costs {
	return Costs{"get": {}, "set": {}, "delete": {}, "keys": {}, "increment": {}, "swap": {}}
}
func inertStore() *storeHost {
	return &storeHost{effect: func(string, SegmentContext) EffectResult { return EffectResult{Status: EffectOK} }, invoke: func(op string, _ *Call, _ []Value) (Value, error) {
		switch op {
		case "keys":
			return List(), nil
		case "increment":
			return Int(1), nil
		case "swap":
			return Bool(true), nil
		}
		return Nothing, nil
	}}
}
func storeRun(t *testing.T, body string, h *storeHost, costs Costs) (*RunEnd, []string) {
	t.Helper()
	core := New()
	def, err := core.StoreCapability(h, costs)
	if err != nil {
		t.Fatal(err)
	}
	var trace lines
	group := core.NewGroup(GroupOptions{Trace: &trace})
	script, err := group.Load(LoadOptions{Name: "s", Source: "on go\n" + body + "\nend go", Grants: map[string]*Grant{"st": def.GrantAll("scores")}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := script.Deliver(Message{Name: "go"}); err != nil {
		t.Fatal(err)
	}
	result, err := group.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	for _, report := range operationalReports(result.Reports) {
		if end, ok := report.(*RunEnd); ok {
			return end, trace
		}
	}
	t.Fatal("No RunEnd")
	return nil, nil
}

func TestAddMatchesScriptAddition(t *testing.T) {
	dec := func(s string) Value {
		v, err := Dec(s)
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	quantity := func(n int64, unit string) Value {
		d, _ := Int(n).AsDec()
		v, err := Quantity(d, unit)
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	for _, test := range []struct {
		a, b Value
		want string
	}{
		{Int(2), Int(3), "5"}, {quantity(5, "m"), quantity(20, "cm"), "5.20 m"},
		{InstantFromTime(time.Unix(0, 0)), quantity(1, "s"), "1970-01-01T00:00:01Z"},
	} {
		v, err := Add(test.a, test.b)
		if err != nil || v.String() != test.want {
			t.Fatalf("got %s %v; want %s", v, err, test.want)
		}
	}
	for _, test := range []struct {
		a, b                Value
		code, data, message string
	}{
		{quantity(1, "m"), quantity(1, "kg"), "incompatible units", `{left: "m", right: "kg"}`, `Can't combine "m" with "kg"`},
		{mustPublicText("7"), Int(1), "wrong kind", `{expected: "number", got: "text", value: "7"}`, `Expected number; got text`},
		{dec("9999999999999999999999999999999999"), Int(1), "overflow", `{operator: "+"}`, `The result of "+" is too large`},
	} {
		_, err := Add(test.a, test.b)
		var script *ScriptError
		if !errors.As(err, &script) || script.Code != test.code || script.Data.String() != test.data {
			t.Fatalf("got %#v; want %s %s", err, test.code, test.data)
		}
		if script.Message == "" {
			t.Fatal("Missing catalogue message")
		}
		if test.code != "wrong kind" && script.Message != test.message {
			t.Fatalf("message %q", script.Message)
		}
	}
}
func TestStoreFactoryCostsAndDeclarations(t *testing.T) {
	core := New()
	for name := range storeCosts() {
		missing := storeCosts()
		delete(missing, name)
		if _, err := core.StoreCapability(inertStore(), missing); err == nil {
			t.Fatalf("accepted missing %s cost", name)
		}
		for _, bad := range []Cost{{Fuel: -1}, {Alloc: -1}, {Fuel: 9007199254740992}, {Alloc: 9007199254740992}} {
			costs := storeCosts()
			costs[name] = bad
			if _, err := core.StoreCapability(inertStore(), costs); err == nil {
				t.Fatalf("accepted %s %v", name, bad)
			}
		}
	}
	var typedNil *storeHost
	for _, h := range []StoreImpl{nil, typedNil} {
		if _, err := core.StoreCapability(h, storeCosts()); err == nil {
			t.Fatal("accepted nil Store")
		}
	}
	costs := storeCosts()
	costs["get"] = Cost{Fuel: 3}
	def, err := core.StoreCapability(inertStore(), costs)
	if err != nil {
		t.Fatal(err)
	}
	costs["get"] = Cost{Fuel: 99}
	if def.ops["get"].Cost.Fuel != 3 {
		t.Fatal("Costs were not copied")
	}
	for name, op := range def.ops {
		writing := name != "get" && name != "keys"
		if op.Mode != Immediate || op.SegmentBound != writing {
			t.Fatalf("incorrect declaration %s", name)
		}
	}
}
func TestStoreEmptyKeyIsUnchargedAfterShapes(t *testing.T) {
	h := inertStore()
	calls := []string{}
	h.invoke = func(op string, _ *Call, _ []Value) (Value, error) { calls = append(calls, op); return Nothing, nil }
	h.effect = func(phase string, _ SegmentContext) EffectResult {
		calls = append(calls, phase)
		return EffectResult{Status: EffectOK}
	}
	for _, body := range []string{`ask st to get ""`, `ask st to set "", 1`, `ask st to delete ""`, `ask st to increment ""`, `ask st to swap "", nothing, 1`} {
		end, lines := storeRun(t, body, h, storeCosts())
		if end.Error == nil || end.Error.Code != "invalid key" || end.Error.Message != "A Store key can't be empty text" {
			t.Fatalf("%s: %#v", body, end.Error)
		}
		for _, line := range lines {
			if strings.HasPrefix(line, "call ") || strings.HasPrefix(line, "effect ") {
				t.Fatal("Empty key crossed the Host", line)
			}
		}
		costly := storeCosts()
		for name := range costly {
			costly[name] = Cost{Fuel: 10000, Alloc: 10000}
		}
		other, _ := storeRun(t, body, h, costly)
		if other.Fuel != end.Fuel || other.Alloc != end.Alloc {
			t.Fatal("Empty key was charged")
		}
	}
	if len(calls) != 0 {
		t.Fatal(calls)
	}
	end, _ := storeRun(t, `put "one" into by`+"\n"+`ask st to increment "", by`, h, storeCosts())
	if end.Error == nil || end.Error.Code != "wrong kind" {
		t.Fatal("Key validation ran before Shape checks", end.Error)
	}
}
func TestStoreOptionalArgumentsAndLifecycle(t *testing.T) {
	h := inertStore()
	phases := []string{}
	supplied := map[string][][]Value{}
	h.effect = func(phase string, c SegmentContext) EffectResult {
		if c.Binding != "scores" || c.Group == nil || c.SegmentID == "" {
			t.Fatal(c)
		}
		phases = append(phases, phase)
		return EffectResult{Status: EffectOK}
	}
	h.invoke = func(op string, c *Call, a []Value) (Value, error) {
		if c.Binding() != "scores" || c.Group() == nil || c.SegmentID() == "" {
			t.Fatal(c)
		}
		supplied[op] = append(supplied[op], a)
		switch op {
		case "keys":
			return List(), nil
		case "increment":
			return a[1], nil
		case "swap":
			return Bool(true), nil
		}
		return Nothing, nil
	}
	end, _ := storeRun(t, `ask st to get "k"`+"\n"+`ask st to keys`+"\n"+`ask st to set "k", 1`+"\n"+`ask st to increment "d", 5 m`+"\n"+`ask st to swap "k", 1, 2`+"\n"+`ask st to delete "k"`, h, storeCosts())
	if end.Outcome != Completed {
		t.Fatal(end.Error)
	}
	if supplied["get"][0][1].Kind() != KindNothing || supplied["keys"][0][0].String() != `""` || supplied["increment"][0][1].String() != "5 m" {
		t.Fatal(supplied)
	}
	if !reflect.DeepEqual(phases, []string{"begin", "commit"}) {
		t.Fatal(phases)
	}
	phases = nil
	end, _ = storeRun(t, `ask st to get "k"`+"\n"+`ask st to keys`, h, storeCosts())
	if end.Outcome != Completed || len(phases) != 0 {
		t.Fatal(end.Error, phases)
	}
}
func TestStoreValidatesHostResultsAndFailures(t *testing.T) {
	data := func(pairs ...Pair) Value { v, _ := Map(pairs...); return v }
	txt := mustPublicText
	for _, test := range []struct {
		op, body string
		result   Value
		failure  error
		want     string
	}{
		{"keys", `ask st to keys`, List(Int(1)), nil, "host error"},
		{"increment", `ask st to increment "k"`, txt("one"), nil, "host error"},
		{"get", `ask st to get "k"`, List(Int(1)), nil, ""},
		{"set", `ask st to set "k", 1`, Nothing, &ScriptError{Code: "store busy", Data: data(KV("key", txt("k")))}, "store busy"},
		{"set", `ask st to set "k", 1`, Nothing, &ScriptError{Code: "store full", Data: data(KV("limit", txt("size")))}, "store full"},
		{"set", `ask st to set "k", 1`, Nothing, &ScriptError{Code: "can't store", Data: data(KV("kind", txt("room")))}, "can't store"},
		{"set", `ask st to set "k", 1`, Nothing, &ScriptError{Code: "store busy"}, "host error"},
		{"set", `ask st to set "k", 1`, Nothing, &ScriptError{Code: "store full", Data: data(KV("limit", txt("disk")))}, "host error"},
		{"set", `ask st to set "k", 1`, Nothing, &ScriptError{Code: "overflow", Data: data(KV("operator", txt("+")))}, "host error"},
		{"set", `ask st to set "k", 1`, Nothing, &ScriptError{Code: "invalid key"}, "host error"},
		{"set", `ask st to set "k", 1`, Nothing, &ScriptError{Code: "custom"}, "host error"},
		{"set", `ask st to set "k", 1`, Nothing, errors.New("disk failed"), "host error"},
		{"delete", `ask st to delete "k"`, Nothing, &ScriptError{Code: "store full", Data: data(KV("limit", txt("keys")))}, "host error"},
		{"get", `ask st to get "k"`, Nothing, &ScriptError{Code: "store busy", Data: data(KV("key", txt("k")))}, "host error"},
		{"increment", `ask st to increment "k"`, Nothing, &ScriptError{Code: "wrong kind", Data: data(KV("expected", txt("number")), KV("got", txt("text")), KV("value", Nothing))}, "wrong kind"},
		{"increment", `ask st to increment "k"`, Nothing, &ScriptError{Code: "wrong kind", Data: data(KV("expected", txt("number")), KV("got", txt("text")))}, "host error"},
		{"increment", `ask st to increment "k"`, Nothing, &ScriptError{Code: "incompatible units", Data: data(KV("left", txt("m")), KV("right", Int(1)))}, "host error"},
		{"increment", `ask st to increment "k"`, Nothing, &ScriptError{Code: "overflow", Data: data(KV("operator", txt("+")))}, "overflow"},
		{"set", `ask st to set "k", 1`, Nothing, &ScriptError{Code: "store busy", Data: data(KV("key", txt("k")), KV("at", Int(1)))}, "host error"},
	} {
		t.Run(test.op+"/"+test.want, func(t *testing.T) {
			h := inertStore()
			h.invoke = func(string, *Call, []Value) (Value, error) { return test.result, test.failure }
			end, _ := storeRun(t, test.body, h, storeCosts())
			got := ""
			if end.Error != nil {
				got = end.Error.Code
			}
			if got != test.want {
				t.Fatalf("got %q (%v), want %q", got, end.Error, test.want)
			}
		})
	}
}
