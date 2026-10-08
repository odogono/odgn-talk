package northtalk

import (
	"errors"
	"strings"
	"testing"
	"time"
)

type calendarHost struct {
	invoke func(string, *Call, []Value) (Value, error)
}

func (h *calendarHost) Today(c *Call, zone string) (Value, error) {
	return h.invoke("today", c, []Value{mustPublicText(zone)})
}
func (h *calendarHost) Now(c *Call, zone string) (Value, error) {
	return h.invoke("now", c, []Value{mustPublicText(zone)})
}
func (h *calendarHost) ToCivil(c *Call, instant Value, zone string) (Value, error) {
	return h.invoke("toCivil", c, []Value{instant, mustPublicText(zone)})
}
func (h *calendarHost) ToInstant(c *Call, civil Value, disambiguation, zone string) (Value, error) {
	return h.invoke("toInstant", c, []Value{civil, mustPublicText(disambiguation), mustPublicText(zone)})
}
func (h *calendarHost) Offset(c *Call, instant Value, zone string) (Value, error) {
	return h.invoke("offset", c, []Value{instant, mustPublicText(zone)})
}
func (h *calendarHost) Zone(c *Call, zone string) (Value, error) {
	return h.invoke("zone", c, []Value{mustPublicText(zone)})
}

func calendarCosts() Costs {
	return Costs{"today": {}, "now": {}, "toCivil": {}, "toInstant": {}, "offset": {}, "zone": {}}
}
func calendarValues(t *testing.T) (Value, Value, Value, Value) {
	t.Helper()
	date, err := ParseCivilDate("2026-10-02")
	if err != nil {
		t.Fatal(err)
	}
	civil, err := ParseCivilDate("2026-10-02T13:00:00")
	if err != nil {
		t.Fatal(err)
	}
	instant := InstantFromTime(time.Date(2026, 10, 2, 12, 0, 0, 0, time.UTC))
	n, _ := Int(3600).AsDec()
	offset, err := Quantity(n, "s")
	if err != nil {
		t.Fatal(err)
	}
	return date, civil, instant, offset
}
func testCalendarHost(t *testing.T) *calendarHost {
	t.Helper()
	date, civil, instant, offset := calendarValues(t)
	return &calendarHost{invoke: func(op string, _ *Call, _ []Value) (Value, error) {
		switch op {
		case "today":
			return date, nil
		case "now", "toCivil":
			return civil, nil
		case "toInstant":
			return instant, nil
		case "offset":
			return offset, nil
		default:
			return mustPublicText("Europe/London"), nil
		}
	}}
}

func TestCalendarFactoryCostsAndNilImplementation(t *testing.T) {
	core := New()
	for _, name := range []string{"today", "now", "toCivil", "toInstant", "offset", "zone"} {
		for _, bad := range []Cost{{Fuel: -1}, {Alloc: -1}, {Fuel: 9007199254740992}, {Alloc: 9007199254740992}} {
			costs := calendarCosts()
			costs[name] = bad
			def, err := core.CalendarCapability(testCalendarHost(t), costs)
			var host *HostError
			if def != nil || !errors.As(err, &host) || host.Code != InvalidValue {
				t.Fatalf("%s %v: %v %v", name, bad, def, err)
			}
		}
		costs := calendarCosts()
		delete(costs, name)
		def, err := core.CalendarCapability(testCalendarHost(t), costs)
		var host *HostError
		if def != nil || !errors.As(err, &host) || host.Code != InvalidValue {
			t.Fatalf("missing %s: %v %v", name, def, err)
		}
	}
	for _, impl := range []CalendarImpl{nil, (*calendarHost)(nil)} {
		def, err := core.CalendarCapability(impl, calendarCosts())
		var host *HostError
		if def != nil || !errors.As(err, &host) || host.Code != InvalidValue {
			t.Fatalf("nil: %v %v", def, err)
		}
	}
	costs := calendarCosts()
	costs["extra"] = Cost{Fuel: -1}
	costs["today"] = Cost{Fuel: 9007199254740991, Alloc: 9007199254740991}
	if _, err := core.CalendarCapability(testCalendarHost(t), costs); err != nil {
		t.Fatal(err)
	}
}

func TestCalendarFactoryOperationsUseCallerAndCopiedCosts(t *testing.T) {
	core := New()
	_, civil, instant, _ := calendarValues(t)
	var names []string
	var args [][]Value
	var calls []*Call
	host := testCalendarHost(t)
	invoke := host.invoke
	host.invoke = func(op string, c *Call, values []Value) (Value, error) {
		names = append(names, op)
		args = append(args, values)
		calls = append(calls, c)
		if err := c.Charge(3); err != nil {
			return Nothing, err
		}
		return invoke(op, c, values)
	}
	costs := calendarCosts()
	for name := range costs {
		costs[name] = Cost{Fuel: 7, Alloc: 2}
	}
	def, err := core.CalendarCapability(host, costs)
	if err != nil || def.Name() != "calendar" {
		t.Fatalf("%v %v", def, err)
	}
	for name := range costs {
		costs[name] = Cost{Fuel: 100000, Alloc: 100000}
	}
	g := core.NewGroup(GroupOptions{})
	source := "on go i, c\n ask cal to today\n ask cal to now \"Europe/London\"\n ask cal to toCivil i, nothing\n ask cal to toInstant c, \"later\", \"UTC\"\n ask cal to offset i\n ask cal to zone nothing\n return it\nend go\n"
	s, err := g.Load(LoadOptions{Name: "s", Source: source, Grants: map[string]*Grant{"cal": def.GrantAll("default-zone")}, Limits: Limits{FuelPerRun: 500, AllocPerRun: 500}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Deliver(Message{Name: "go", Args: []Value{instant, civil}}); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 2, 12, 0, 0, 123456789, time.UTC)
	result, err := g.Pump(now, PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	end := joinEnd(t, result, "s")
	if end.Outcome != Completed || end.Result.String() != `"Europe/London"` || strings.Join(names, ",") != "today,now,toCivil,toInstant,offset,zone" {
		t.Fatalf("%+v %v", end, names)
	}
	for i, c := range calls {
		if c.ScriptName() != "s" || c.GrantName() != "cal" || c.Binding() != "default-zone" || c.Group() != g || !c.Now().Equal(now) {
			t.Fatalf("call %d %+v", i, c)
		}
	}
	want := [][]Value{{mustPublicText("")}, {mustPublicText("Europe/London")}, {instant, mustPublicText("")}, {civil, mustPublicText("later"), mustPublicText("UTC")}, {instant, mustPublicText("")}, {mustPublicText("")}}
	for i, values := range args {
		if !List(values...).Equal(List(want[i]...)) {
			t.Fatalf("args %d: %v", i, values)
		}
	}
}

func TestCalendarFactoryToInstantDefaultsAndUnchargedDomainChecks(t *testing.T) {
	date, civil, instant, _ := calendarValues(t)
	text := mustPublicText
	for _, tc := range []struct {
		name                       string
		args                       []Value
		disambiguation, zone, code string
		offender                   Value
	}{
		{name: "omitted", args: []Value{civil}, disambiguation: "compatible"},
		{name: "nothing", args: []Value{civil, Nothing}, disambiguation: "compatible"},
		{name: "word", args: []Value{civil, text("earlier")}, disambiguation: "earlier"},
		{name: "zone", args: []Value{civil, text("Europe/London")}, disambiguation: "compatible", zone: "Europe/London"},
		{name: "both", args: []Value{civil, text("reject"), text("UTC")}, disambiguation: "reject", zone: "UTC"},
		{name: "default word", args: []Value{civil, Nothing, text("UTC")}, disambiguation: "compatible", zone: "UTC"},
		{name: "default zone", args: []Value{civil, text("later"), Nothing}, disambiguation: "later"},
		{name: "both nothing", args: []Value{civil, Nothing, Nothing}, disambiguation: "compatible"},
		{name: "date only", args: []Value{date}, code: "out of domain", offender: date},
		{name: "invalid word", args: []Value{civil, text("UTC"), text("Europe/London")}, code: "out of domain", offender: text("UTC")},
		{name: "Shape before domain", args: []Value{date, Int(3)}, code: "wrong kind"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			core := New()
			invoked := false
			host := testCalendarHost(t)
			host.invoke = func(op string, c *Call, args []Value) (Value, error) {
				invoked = true
				if op != "toInstant" || args[1].String() != text(tc.disambiguation).String() || args[2].String() != text(tc.zone).String() {
					t.Fatal(op, args)
				}
				return instant, nil
			}
			costs := calendarCosts()
			costs["toInstant"] = Cost{Fuel: 100, Alloc: 100}
			def, err := core.CalendarCapability(host, costs)
			if err != nil {
				t.Fatal(err)
			}
			var trace lines
			g := core.NewGroup(GroupOptions{Trace: &trace})
			params := []string{"c", "a", "b"}
			source := "on go " + strings.Join(params[:len(tc.args)], ", ") + "\n ask cal to toInstant " + strings.Join(params[:len(tc.args)], ", ") + "\n return it\nend go\n"
			limits := Limits{}
			if tc.code != "" {
				limits = Limits{FuelPerRun: 50, AllocPerRun: 80}
			}
			s, err := g.Load(LoadOptions{Name: "s", Source: source, Grants: map[string]*Grant{"cal": def.GrantAll(nil)}, Limits: limits})
			if err != nil {
				t.Fatal(err)
			}
			if _, err = s.Deliver(Message{Name: "go", Args: tc.args}); err != nil {
				t.Fatal(err)
			}
			result, err := g.Pump(time.Date(2026, 10, 2, 12, 0, 0, 0, time.UTC), PumpOptions{})
			if err != nil {
				t.Fatal(err)
			}
			end := joinEnd(t, result, "s")
			if tc.code == "" {
				if !invoked || end.Outcome != Completed || !end.Result.Equal(instant) {
					t.Fatal(end)
				}
			} else {
				if invoked || end.Outcome != Errored || end.Error == nil || end.Error.Code != tc.code {
					t.Fatalf("invoked=%v %+v", invoked, end)
				}
				if tc.code == "out of domain" && (!end.Error.Data.Get("value").Equal(tc.offender) || end.Error.Data.Get("function").String() != `"toInstant"`) {
					t.Fatal(end.Error)
				}
				if strings.Contains(strings.Join(trace, "\n"), "call s/r1") {
					t.Fatal(trace)
				}
			}
		})
	}
}

func TestCalendarFactoryResultRefinementsAndCatalogueFailures(t *testing.T) {
	date, civil, instant, _ := calendarValues(t)
	n, _ := Int(60).AsDec()
	minutes, err := Quantity(n, "min")
	if err != nil {
		t.Fatal(err)
	}
	fields := func(pairs ...Pair) Value {
		v, err := Map(pairs...)
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	zone := KV("zone", mustPublicText("Mars"))
	for _, tc := range []struct {
		name, op string
		result   Value
		failure  *ScriptError
		want     string
	}{
		{name: "today time", op: "today", result: civil, want: "host error"},
		{name: "now date", op: "now", result: date, want: "host error"},
		{name: "toCivil date", op: "toCivil", result: date, want: "host error"},
		{name: "toInstant kind", op: "toInstant", result: civil, want: "host error"},
		{name: "offset unit", op: "offset", result: minutes, want: "host error"},
		{name: "zone kind", op: "zone", result: Int(0), want: "host error"},
		{name: "unknown zone", op: "today", failure: &ScriptError{Code: "unknown zone", Data: fields(zone)}, want: "unknown zone"},
		{name: "ambiguous time", op: "toInstant", failure: &ScriptError{Code: "ambiguous time", Data: fields(KV("civil", civil), zone)}, want: "ambiguous time"},
		{name: "missing zone", op: "now", failure: &ScriptError{Code: "unknown zone"}, want: "host error"},
		{name: "wrong zone", op: "zone", failure: &ScriptError{Code: "unknown zone", Data: fields(KV("zone", Int(3)))}, want: "host error"},
		{name: "missing civil", op: "toInstant", failure: &ScriptError{Code: "ambiguous time", Data: fields(zone)}, want: "host error"},
		{name: "wrong civil", op: "toInstant", failure: &ScriptError{Code: "ambiguous time", Data: fields(KV("civil", mustPublicText("bad")), zone)}, want: "host error"},
		{name: "undeclared ambiguous", op: "today", failure: &ScriptError{Code: "ambiguous time", Data: fields(KV("civil", civil), zone)}, want: "host error"},
		{name: "other catalogue", op: "now", failure: &ScriptError{Code: "division by zero"}, want: "host error"},
		{name: "custom failure", op: "offset", failure: &ScriptError{Code: "service down"}, want: "host error"},
		{name: "reserved fields", op: "toCivil", failure: &ScriptError{Code: "unknown zone", Data: fields(zone, KV("at", Int(1)))}, want: "host error"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			core := New()
			host := testCalendarHost(t)
			host.invoke = func(string, *Call, []Value) (Value, error) {
				if tc.failure != nil {
					return Nothing, tc.failure
				}
				return tc.result, nil
			}
			def, err := core.CalendarCapability(host, calendarCosts())
			if err != nil {
				t.Fatal(err)
			}
			arg := ""
			values := []Value{}
			switch tc.op {
			case "toCivil", "offset":
				arg = " x"
				values = []Value{instant}
			case "toInstant":
				arg = " x"
				values = []Value{civil}
			}
			params := ""
			if len(values) > 0 {
				params = " x"
			}
			g := core.NewGroup(GroupOptions{})
			s, err := g.Load(LoadOptions{Name: "s", Source: "on go" + params + "\n ask cal to " + tc.op + arg + "\nend go\n", Grants: map[string]*Grant{"cal": def.GrantAll(nil)}})
			if err != nil {
				t.Fatal(err)
			}
			if _, err = s.Deliver(Message{Name: "go", Args: values}); err != nil {
				t.Fatal(err)
			}
			result, err := g.Pump(time.Date(2026, 10, 2, 12, 0, 0, 0, time.UTC), PumpOptions{})
			if err != nil {
				t.Fatal(err)
			}
			end := joinEnd(t, result, "s")
			if end.Outcome != Errored || end.Error == nil || end.Error.Code != tc.want || end.Error.Data.Get("capability").String() != `"cal"` {
				t.Fatal(end)
			}
			hostFailure := false
			for _, report := range operationalReports(result.Reports) {
				if failed, ok := report.(*CallFailed); ok {
					hostFailure = true
					if failed.Operation.Capability != "calendar" || failed.Operation.Operation != tc.op {
						t.Fatal(failed)
					}
				}
			}
			if hostFailure != (tc.want == "host error") {
				t.Fatal(result)
			}
		})
	}
}

func TestCalendarFactoryChecksAreNotAvailableToOrdinaryDeclarations(t *testing.T) {
	core := New()
	data, _ := Map(KV("zone", mustPublicText("Mars")))
	def, err := core.DefineCapability("calendar", Operation{Name: "today", Mode: Immediate, Result: CivilDateShape, Errors: []ErrorDecl{{Code: "unknown zone", Fields: []Field{{Key: "zone", Shape: TextShape}}}}, Do: func(*Call, []Value) (Value, error) { return Nothing, &ScriptError{Code: "unknown zone", Data: data} }})
	if err != nil {
		t.Fatal(err)
	}
	g := core.NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: "on go\n ask calendar to today\nend go\n", Grants: map[string]*Grant{"calendar": def.GrantAll(nil)}})
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
	if end.Error == nil || end.Error.Code != "host error" {
		t.Fatal(end)
	}
}

func TestCalendarFactoryLibraryCallsUseCallerRefinements(t *testing.T) {
	core := New()
	_, civil, instant, _ := calendarValues(t)
	decls := GrantDecls{"cal": {"toInstant": {Mode: Immediate, Args: []Shape{CivilDateShape, Optional(TextShape), Optional(TextShape)}}}}
	lib, err := core.CompileLibrary(LibrarySource{Name: "helper", Source: "function convert c, word\n ask cal to toInstant c, word, nothing\n return it\nend convert\n"}, nil, decls)
	if err != nil {
		t.Fatal(err)
	}
	for _, word := range []string{"later", "invalid"} {
		t.Run(word, func(t *testing.T) {
			called := false
			host := testCalendarHost(t)
			host.invoke = func(op string, c *Call, args []Value) (Value, error) {
				called = true
				if c.Binding() != "tenant" || c.ScriptName() != "s" || c.GrantName() != "cal" || args[1].String() != `"later"` {
					t.Fatal(c, args)
				}
				return instant, nil
			}
			def, err := core.CalendarCapability(host, calendarCosts())
			if err != nil {
				t.Fatal(err)
			}
			g := core.NewGroup(GroupOptions{})
			if err = g.AddLibrary(lib); err != nil {
				t.Fatal(err)
			}
			s, err := g.Load(LoadOptions{Name: "s", Source: "use convert from helper\non go c, word\n return convert(c, word)\nend go\n", Grants: map[string]*Grant{"cal": def.GrantAll("tenant")}, GrantsAsUsed: true})
			if err != nil {
				t.Fatal(err)
			}
			if kept := s.Grants()["cal"]; len(kept) != 1 || kept[0] != "toInstant" {
				t.Fatal(kept)
			}
			if _, err = s.Deliver(Message{Name: "go", Args: []Value{civil, mustPublicText(word)}}); err != nil {
				t.Fatal(err)
			}
			result, err := g.Pump(time.Date(2026, 10, 2, 12, 0, 0, 0, time.UTC), PumpOptions{})
			if err != nil {
				t.Fatal(err)
			}
			end := joinEnd(t, result, "s")
			if word == "later" {
				if !called || end.Outcome != Completed || !end.Result.Equal(instant) {
					t.Fatal(end)
				}
			} else if called || end.Error == nil || end.Error.Code != "out of domain" || end.Error.Data.Get("at").Get("unit").String() != `"helper"` {
				t.Fatalf("called=%v %+v", called, end)
			}
		})
	}
}
