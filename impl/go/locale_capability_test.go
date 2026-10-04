package northtalk

import (
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

type localeHost struct {
	invoke func(string, *Call, []Value, string) (Value, error)
}

func (h *localeHost) Compare(c *Call, a, b, opts Value, tag string) (Value, error) {
	return h.invoke("compare", c, []Value{a, b, opts}, tag)
}
func (h *localeHost) Rank(c *Call, texts, opts Value, tag string) (Value, error) {
	return h.invoke("rank", c, []Value{texts, opts}, tag)
}
func (h *localeHost) Upper(c *Call, s Value, tag string) (Value, error) {
	return h.invoke("upper", c, []Value{s}, tag)
}
func (h *localeHost) Lower(c *Call, s Value, tag string) (Value, error) {
	return h.invoke("lower", c, []Value{s}, tag)
}
func (h *localeHost) NumberSymbols(c *Call, tag string) (Value, error) {
	return h.invoke("numberSymbols", c, nil, tag)
}
func (h *localeHost) MonthNames(c *Call, opts Value, tag string) (Value, error) {
	return h.invoke("monthNames", c, []Value{opts}, tag)
}
func (h *localeHost) DayNames(c *Call, opts Value, tag string) (Value, error) {
	return h.invoke("dayNames", c, []Value{opts}, tag)
}
func (h *localeHost) Tag(c *Call, tag string) (Value, error) {
	return h.invoke("tag", c, nil, tag)
}
func localeCosts() Costs {
	return Costs{"compare": {}, "rank": {}, "upper": {}, "lower": {}, "numberSymbols": {}, "monthNames": {}, "dayNames": {}, "tag": {}}
}
func localeNames(n int) Value {
	values := make([]Value, n)
	for i := range values {
		values[i] = mustPublicText(fmt.Sprint(i))
	}
	return List(values...)
}
func localeMap(t *testing.T, pairs ...Pair) Value {
	t.Helper()
	v, err := Map(pairs...)
	if err != nil {
		t.Fatal(err)
	}
	return v
}
func localeSymbols(t *testing.T) Value {
	return localeMap(t, KV("decimal", mustPublicText(".")), KV("group", mustPublicText(",")), KV("minus", mustPublicText("-")), KV("digits", localeNames(10)), KV("primaryGroup", Int(3)), KV("secondaryGroup", Int(3)), KV("minGrouping", Int(1)))
}
func runLocale(t *testing.T, op string, args []Value, binding string, answer Value, failure error) (*RunEnd, PumpResult, string, bool) {
	t.Helper()
	called := false
	host := &localeHost{invoke: func(string, *Call, []Value, string) (Value, error) {
		called = true
		return answer, failure
	}}
	core := New()
	costs := localeCosts()
	// Invalid arguments must fail even when the Run cannot afford the call.
	costs[op] = Cost{Fuel: 1000, Alloc: 1000}
	def, err := core.LocaleCapability(host, costs)
	if err != nil {
		t.Fatal(err)
	}
	var trace lines
	g := core.NewGroup(GroupOptions{Trace: &trace})
	params := make([]string, len(args))
	for i := range params {
		params[i] = fmt.Sprintf("p%d", i)
	}
	argText := strings.Join(params, ", ")
	source := "on go " + argText + "\n ask loc to " + op + " " + argText + "\n return it\nend go\n"
	limit := int64(10000)
	if answer.Equal(Nothing) && failure == nil {
		limit = 500
	}
	s, err := g.Load(LoadOptions{Name: "s", Source: source, Grants: map[string]*Grant{"loc": def.GrantAll(binding)}, Limits: Limits{FuelPerRun: limit, AllocPerRun: limit}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Deliver(Message{Name: "go", Args: args}); err != nil {
		t.Fatal(err)
	}
	result, err := g.Pump(time.Date(2026, 10, 2, 12, 0, 0, 0, time.UTC), PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	return joinEnd(t, result, "s"), result, strings.Join(trace, "\n"), called
}

func TestLocaleFactoryCostsAndNilImplementation(t *testing.T) {
	core := New()
	host := &localeHost{}
	for name := range localeCosts() {
		for _, bad := range []Cost{{Fuel: -1}, {Alloc: -1}, {Fuel: 9007199254740992}, {Alloc: 9007199254740992}} {
			costs := localeCosts()
			costs[name] = bad
			_, err := core.LocaleCapability(host, costs)
			var e *HostError
			if !errors.As(err, &e) || e.Code != InvalidValue {
				t.Fatalf("%s %v: %v", name, bad, err)
			}
		}
		costs := localeCosts()
		delete(costs, name)
		if _, err := core.LocaleCapability(host, costs); err == nil {
			t.Fatal("accepted missing cost", name)
		}
	}
	for _, host := range []LocaleImpl{nil, (*localeHost)(nil)} {
		if _, err := core.LocaleCapability(host, localeCosts()); err == nil {
			t.Fatal("accepted nil implementation")
		}
	}
	costs := localeCosts()
	costs["extra"] = Cost{Fuel: -1}
	costs["tag"] = Cost{Fuel: 9007199254740991, Alloc: 9007199254740991}
	if _, err := core.LocaleCapability(host, costs); err != nil {
		t.Fatal(err)
	}
}

func TestLocaleFactoryDefaultsCallerAndCopiedCosts(t *testing.T) {
	core := New()
	now := time.Date(2026, 10, 2, 12, 0, 0, 0, time.UTC)
	want := []string{
		`compare ["a", "b", {sensitivity: "variant", numeric: false}] `,
		`rank [["a", "a"], {sensitivity: "base", numeric: true}] de`,
		`upper ["i"] tr`, `lower ["I"] tr`, `numberSymbols [] `,
		`monthNames [{width: "short", form: "format"}] `,
		`dayNames [{width: "long", form: "standalone"}] fr`,
		`dayNames [{width: "long", form: "format"}] fr`,
		`compare ["a", "b", {sensitivity: "variant", numeric: false}] dE`,
		`rank [["a"], {sensitivity: "variant", numeric: false}] de`, `tag [] `,
	}
	answers := map[string]Value{"compare": Int(-1), "rank": localeMap(t, KV("a", Int(1))), "upper": mustPublicText("e\u0301"), "lower": mustPublicText("ı"), "numberSymbols": localeSymbols(t), "monthNames": localeNames(12), "dayNames": localeNames(7), "tag": mustPublicText("en-GB")}
	seen := 0
	host := &localeHost{invoke: func(op string, c *Call, args []Value, tag string) (Value, error) {
		if c.Binding() != "en-GB" || c.ScriptName() != "s" || c.GrantName() != "loc" || c.Now() != now || c.Group() == nil || c.RunID() != "s/r1" {
			t.Fatal(c)
		}
		if got := op + " " + List(args...).String() + " " + tag; seen >= len(want) || got != want[seen] {
			t.Fatal(got, seen)
		}
		seen++
		if err := c.Charge(3); err != nil {
			t.Fatal(err)
		}
		return answers[op], nil
	}}
	costs := localeCosts()
	for name := range costs {
		costs[name] = Cost{Fuel: 7, Alloc: 2}
	}
	def, err := core.LocaleCapability(host, costs)
	if err != nil {
		t.Fatal(err)
	}
	for name := range costs {
		costs[name] = Cost{Fuel: 100000, Alloc: 100000}
	}
	var trace lines
	g := core.NewGroup(GroupOptions{Trace: &trace})
	s, err := g.Load(LoadOptions{Name: "s", Source: `on go
 ask loc to compare "a", "b", nothing, nothing
 ask loc to rank ["a", "a"], {numeric: true, sensitivity: "base"}, "de"
 ask loc to upper "i", "tr"
 put it into normalized
 ask loc to lower "I", "tr"
 ask loc to numberSymbols nothing
 ask loc to monthNames {width: "short"}
 ask loc to dayNames {form: "standalone"}, "fr"
 ask loc to dayNames "fr"
 ask loc to compare "a", "b", "dE"
 ask loc to rank ["a"], nothing, "de"
 ask loc to tag
 return [normalized, it]
end go`, Grants: map[string]*Grant{"loc": def.GrantAll("en-GB")}, Limits: Limits{FuelPerRun: 1000}})
	if err != nil {
		t.Fatal(err)
	}
	s.Deliver(Message{Name: "go"})
	result, err := g.Pump(now, PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	end := joinEnd(t, result, "s")
	if seen != len(want) || end.Outcome != Completed || end.Result.String() != `["é", "en-GB"]` || !strings.Contains(strings.Join(trace, "\n"), `args=["a", "b", nothing, nothing]`) {
		t.Fatal(seen, end, trace)
	}
}

func TestLocaleFactoryUnchargedArgumentChecks(t *testing.T) {
	text := mustPublicText
	for _, tc := range []struct {
		name, op, binding, code string
		args                    []Value
		offender                Value
	}{
		{"bad explicit tag", "tag", "en", "bad locale", []Value{text("en_US")}, text("en_US")},
		{"bad default tag", "tag", "en_US", "bad locale", nil, text("en_US")},
		{"Nothing tag", "upper", "en_US", "bad locale", []Value{text("x"), Nothing}, text("en_US")},
		{"two tags", "compare", "en", "out of domain", []Value{text("a"), text("b"), text("de"), text("fr")}, text("de")},
		{"option map order", "monthNames", "bad_tag", "out of domain", []Value{localeMap(t, KV("form", text("wrong form")), KV("width", text("wrong width")))}, text("wrong form")},
		{"sensitivity", "rank", "en", "out of domain", []Value{List(), localeMap(t, KV("sensitivity", text("wrong")))}, text("wrong")},
		{"closed map", "dayNames", "en", "wrong kind", []Value{localeMap(t, KV("extra", text("long")))}, Nothing},
		{"Nothing field", "monthNames", "en", "wrong kind", []Value{localeMap(t, KV("width", Nothing))}, Nothing},
		{"Shape before domain", "compare", "bad_tag", "wrong kind", []Value{text("a"), text("b"), localeMap(t, KV("sensitivity", text("wrong")), KV("numeric", text("yes")))}, Nothing},
		{"later Shape before domain", "compare", "en", "wrong kind", []Value{text("a"), text("b"), localeMap(t, KV("sensitivity", text("wrong"))), Int(3)}, Nothing},
		{"list item Shape", "rank", "en", "wrong kind", []Value{List(text("a"), Int(1))}, Nothing},
	} {
		t.Run(tc.name, func(t *testing.T) {
			end, _, trace, called := runLocale(t, tc.op, tc.args, tc.binding, Nothing, nil)
			if called || end.Error == nil || end.Error.Code != tc.code || strings.Contains(trace, "call s/") {
				t.Fatal(end, trace, called)
			}
			if tc.code == "out of domain" && (!end.Error.Data.Get("value").Equal(tc.offender) || end.Error.Data.Get("function").String() != text(tc.op).String()) {
				t.Fatal(end.Error)
			}
			if tc.code == "bad locale" && !end.Error.Data.Get("locale").Equal(tc.offender) {
				t.Fatal(end.Error)
			}
		})
	}
}

func TestLocaleFactoryTagSyntaxAndExplicitOverride(t *testing.T) {
	valid := []string{"und", "en-GB", "ZH-cmn-hANS-cn", "abcd", "abcdefgh", "es-419", "de-1901", "en-a-abc-b-12-x-private", "x-a", "i-klingon", "sgn-BE-FR", "en-GB-oed", "qzz-QZ", "en-1901-1901", "en-a-abc-a-def", "zh-min-nan"}
	invalid := []string{"", "en_US", "en--GB", "en-", "x", "i-madeup", "a-abc", "en-a", "en-x", "en-1234abcd9", "en-GB-Latn", "en-12", "é", "en\n", " en", "en ", "abcdefghi", "en-abc-def-ghi-jkl", "en-abcd-1234-abc", "en-ſabc"}
	for _, tag := range valid {
		end, _, _, called := runLocale(t, "tag", []Value{mustPublicText(tag)}, "bad_default", mustPublicText(tag), nil)
		if !called || end.Outcome != Completed || end.Result.String() != mustPublicText(tag).String() {
			t.Fatalf("valid %q: %+v", tag, end)
		}
	}
	for _, tag := range invalid {
		for _, explicit := range []bool{false, true} {
			var args []Value
			if explicit {
				args = []Value{mustPublicText(tag)}
			}
			end, _, _, called := runLocale(t, "tag", args, tag, Nothing, nil)
			if called || end.Error == nil || end.Error.Code != "bad locale" || end.Error.Data.Get("locale").String() != mustPublicText(tag).String() {
				t.Fatalf("invalid %q explicit=%v: %+v", tag, explicit, end)
			}
		}
	}
	// Grant bindings stay Host strings: unlike Values, they do not receive NFC.
	end, _, _, called := runLocale(t, "tag", nil, "en-Kabc", Nothing, nil)
	if called || end.Error == nil || end.Error.Code != "bad locale" {
		t.Fatal("non-ASCII binding accepted by regexp case folding", end)
	}
}

func TestLocaleFactoryResultRefinementsAndHostFailures(t *testing.T) {
	text := mustPublicText
	fraction, _ := Dec("1.000000000000000000000000000000001")
	large, _ := Dec("9999999999999999999999999999999999")
	rankArgs := []Value{List(text("a"), text("b"), text("a"))}
	for _, tc := range []struct {
		name, op string
		args     []Value
		answer   Value
		valid    bool
	}{
		{"compare negative", "compare", []Value{text("a"), text("b")}, Int(-1), true},
		{"compare fraction", "compare", []Value{text("a"), text("b")}, fraction, false},
		{"compare range", "compare", []Value{text("a"), text("b")}, Int(2), false},
		{"rank dense", "rank", rankArgs, localeMap(t, KV("b", Int(2)), KV("a", Int(1))), true},
		{"rank ties", "rank", rankArgs, localeMap(t, KV("a", Int(1)), KV("b", Int(1))), true},
		{"rank gap", "rank", rankArgs, localeMap(t, KV("a", Int(1)), KV("b", Int(3))), false},
		{"rank starts two", "rank", rankArgs, localeMap(t, KV("a", Int(2)), KV("b", Int(2))), false},
		{"rank missing", "rank", rankArgs, localeMap(t, KV("a", Int(1))), false},
		{"rank extra", "rank", rankArgs, localeMap(t, KV("a", Int(1)), KV("b", Int(2)), KV("c", Int(3))), false},
		{"rank fraction", "rank", rankArgs, localeMap(t, KV("a", Int(1)), KV("b", fraction)), false},
		{"rank zero", "rank", rankArgs, localeMap(t, KV("a", Int(0)), KV("b", Int(1))), false},
		{"rank wrong key", "rank", rankArgs, localeMap(t, KV("a", Int(1)), KV("c", Int(2))), false},
		{"empty rank", "rank", []Value{List()}, localeMap(t), true},
		{"month count", "monthNames", nil, localeNames(11), false},
		{"day count", "dayNames", nil, localeNames(8), false},
		{"day item", "dayNames", nil, List(Int(1), Int(2), Int(3), Int(4), Int(5), Int(6), Int(7)), false},
		{"symbols", "numberSymbols", nil, localeSymbols(t), true},
		{"symbols missing fields", "numberSymbols", nil, localeMap(t), false},
		{"tag syntax", "tag", nil, text("en_US"), false},
		{"upper kind", "upper", []Value{text("x")}, Int(1), false},
		{"lower kind", "lower", []Value{text("x")}, Int(1), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			end, result, _, called := runLocale(t, tc.op, tc.args, "en", tc.answer, nil)
			if !called || tc.valid && (end.Outcome != Completed || !end.Result.Equal(tc.answer)) || !tc.valid && (end.Error == nil || end.Error.Code != "host error") {
				t.Fatal(end)
			}
			if !tc.valid {
				if end.Error.Data.Get("capability").String() != `"loc"` || len(result.Reports) < 2 {
					t.Fatal(result)
				}
				found := false
				for _, report := range result.Reports {
					if r, ok := report.(*CallFailed); ok {
						found = r.Operation.Capability == "locale" && r.Operation.Operation == tc.op
					}
				}
				if !found {
					t.Fatal(result.Reports)
				}
			}
		})
	}
	for _, replace := range []Pair{KV("decimal", text("")), KV("digits", localeNames(9)), KV("digits", List(text(""), text("1"), text("2"), text("3"), text("4"), text("5"), text("6"), text("7"), text("8"), text("9"))), KV("primaryGroup", Int(0)), KV("secondaryGroup", fraction), KV("minGrouping", Int(-1)), KV("extra", Int(1))} {
		pairs := localeSymbols(t).Entries()
		out := []Pair{}
		for _, p := range pairs {
			if p.Key != replace.Key {
				out = append(out, p)
			}
		}
		end, _, _, _ := runLocale(t, "numberSymbols", nil, "en", localeMap(t, append(out, replace)...), nil)
		if end.Error == nil || end.Error.Code != "host error" {
			t.Fatal(replace, end)
		}
	}
	pairs := localeSymbols(t).Entries()
	pairs[len(pairs)-1] = KV("minGrouping", large)
	if end, _, _, _ := runLocale(t, "numberSymbols", nil, "en", localeMap(t, pairs...), nil); end.Outcome != Completed {
		t.Fatal("positive integers are not bounded by int64", end)
	}
	for _, failure := range []error{errors.New("Host failed"), &ScriptError{Code: "custom"}, &ScriptError{Code: "bad locale", Data: localeMap(t, KV("locale", text("en")))}} {
		end, _, _, _ := runLocale(t, "tag", nil, "en", text("en"), failure)
		if end.Error == nil || end.Error.Code != "host error" {
			t.Fatal(end)
		}
	}
}

func TestLocaleFactoryLibraryCallsUseCallerBindingAndDefaults(t *testing.T) {
	core := New()
	optionShape := Optional(OneOf(MapShape(Field{Key: "width", Shape: TextShape, Optional: true}, Field{Key: "form", Shape: TextShape, Optional: true}), TextShape))
	lib, err := core.CompileLibrary(LibrarySource{Name: "helper", Source: "function names tag\n ask loc to dayNames nothing, tag\n return it\nend names\n"}, nil, GrantDecls{"loc": {"dayNames": {Mode: Immediate, Args: []Shape{optionShape, Optional(TextShape)}}}})
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		tag  Value
		code string
	}{
		{Nothing, "bad locale"}, {mustPublicText("fr"), ""}, {mustPublicText("fr_FR"), "bad locale"},
	} {
		called := false
		host := &localeHost{invoke: func(op string, c *Call, args []Value, tag string) (Value, error) {
			called = true
			if op != "dayNames" || c.Binding() != "bad_default" || c.ScriptName() != "s" || c.GrantName() != "loc" || tag != "fr" || args[0].String() != `{width: "long", form: "format"}` {
				t.Fatal(c, args, tag)
			}
			return localeNames(7), nil
		}}
		def, err := core.LocaleCapability(host, localeCosts())
		if err != nil {
			t.Fatal(err)
		}
		g := core.NewGroup(GroupOptions{})
		if err = g.AddLibrary(lib); err != nil {
			t.Fatal(err)
		}
		s, err := g.Load(LoadOptions{Name: "s", Source: "use names from helper\non go tag\n return names(tag)\nend go\n", Grants: map[string]*Grant{"loc": def.GrantAll("bad_default")}, GrantsAsUsed: true})
		if err != nil {
			t.Fatal(err)
		}
		if kept := s.Grants()["loc"]; len(kept) != 1 || kept[0] != "dayNames" {
			t.Fatal(kept)
		}
		if _, err = s.Deliver(Message{Name: "go", Args: []Value{tc.tag}}); err != nil {
			t.Fatal(err)
		}
		result, err := g.Pump(time.Date(2026, 10, 2, 12, 0, 0, 0, time.UTC), PumpOptions{})
		if err != nil {
			t.Fatal(err)
		}
		end := joinEnd(t, result, "s")
		if tc.code == "" {
			if !called || end.Outcome != Completed || !end.Result.Equal(localeNames(7)) {
				t.Fatal(end)
			}
		} else if called || end.Error == nil || end.Error.Code != tc.code || end.Error.Data.Get("at").Get("unit").String() != `"helper"` {
			t.Fatal(end, called)
		}
	}
}
