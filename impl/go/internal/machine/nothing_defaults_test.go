package machine

import (
	"sync/atomic"
	"testing"

	"github.com/odogono/odgn-talk/impl/go/internal/value"
)

// Design groups 1 and 4 (#720): `otherwise` defaults only Nothing, and
// optional reads return a map's value or Nothing.
func TestOtherwiseDefaultsOnlyNothing(t *testing.T) {
	for _, tc := range []struct{ expression, want string }{
		{"nothing otherwise 2", "2"},
		{"false otherwise 2", "false"},
		{"0 otherwise 2", "0"},
		{`"" otherwise 2`, `""`},
		{"[] otherwise 2", "[]"},
		{"{} otherwise 2", "{}"},
		{"nothing otherwise nothing", "nothing"},
		{"nothing otherwise nothing otherwise 3", "3"},
		{"the missing of {a: 1} otherwise 9", "9"},
		{"the optional a of {a: 1}", "1"},
		{"the optional b of {a: 1}", "nothing"},
		{"the optional a of {a: nothing}", "nothing"},
		{"the optional a of nothing", "nothing"},
		{"the optional b of the optional a of {a: {b: 4}}", "4"},
		{"the optional b of the optional a of {}", "nothing"},
		{"the optional length of {length: 7}", "7"},
		{"the optional first of {first: 8}", "8"},
		{"the optional target of {target: 9}", "9"},
		{"the optional optional of {optional: 10}", "10"},
		{`the optional "of" of {"of": 11}`, "11"},
		{"the optional of {optional: 12}", "12"},
		{"the optional (\"a\") of {a: 13}", "13"},
		{"the length of [1, 2, 3]", "3"},
	} {
		r := executeSource(t, "on go\n return "+tc.expression+"\nend go\n")
		if r.Status != Completed || r.Result.Display() != tc.want {
			t.Errorf("%s: status=%v result=%s, want %s", tc.expression, r.Status, r.Result.Display(), tc.want)
		}
	}
}

// Design group 2: each side runs once, the fallback only when selected,
// and the design's exact Fuel totals hold (clause 4 + return 2 surround
// the expression in these handlers).
func TestOtherwiseEvaluationAndFuel(t *testing.T) {
	for _, tc := range []struct {
		expression string
		want       string
		fuel       int64 // the design's total for the expression alone
	}{
		{"1 otherwise 2", "1", 2},
		{"nothing otherwise 2", "2", 4},
		{"1 otherwise 2 otherwise 3", "1", 3},
		{"nothing otherwise nothing otherwise 3", "3", 7},
		{"the optional a of nothing", "nothing", 4}, // const + get-optional-key
	} {
		r := executeSource(t, "on go\n return "+tc.expression+"\nend go\n")
		if r.Status != Completed || r.Result.Display() != tc.want {
			t.Fatalf("%s: status=%v result=%s", tc.expression, r.Status, r.Result.Display())
		}
		if got := r.Fuel - 6; got != tc.fuel {
			t.Errorf("%s: expression Fuel=%d, want %d (run Fuel=%d)", tc.expression, got, tc.fuel, r.Fuel)
		}
	}
	// A failing optional read charges the same Fuel as a failing ordinary
	// read: its 3 Fuel is not refunded by the failure.
	optionalFail := executeSource(t, "on go\n return the optional a of 5\nend go\n")
	ordinaryFail := executeSource(t, "on go\n return the a of 5\nend go\n")
	if optionalFail.Status != Errored || ordinaryFail.Status != Errored || optionalFail.Fuel != ordinaryFail.Fuel {
		t.Errorf("failing reads: optional status=%v Fuel=%d, ordinary status=%v Fuel=%d",
			optionalFail.Status, optionalFail.Fuel, ordinaryFail.Status, ordinaryFail.Fuel)
	}

	counting := "script variable calls = 0\n" +
		"on bump v\n put calls + 1 into calls\n return v\nend bump\n" +
		"on go\n put bump(nothing) otherwise bump(5) into x\n put bump(7) otherwise bump(9) into y\n return [x, y, calls]\nend go\n"
	r := executeSource(t, counting)
	if r.Status != Completed || r.Result.Display() != "[5, 7, 3]" {
		t.Fatalf("counting: status=%v result=%s", r.Status, r.Result.Display())
	}

	// An unselected fallback does not run, and a left-side error propagates.
	r = executeSource(t, "on go\n return 1 otherwise 1 / 0\nend go\n")
	if r.Status != Completed || r.Result.Display() != "1" {
		t.Fatalf("lazy: status=%v result=%s", r.Status, r.Result.Display())
	}
	r = executeSource(t, "on go\n return 1 / 0 otherwise 2\nend go\n")
	if r.Status != Errored {
		t.Fatalf("left error: status=%v result=%s", r.Status, r.Result.Display())
	}
}

// Design group 5: computed keys run before the receiver, an invalid key
// is reported only after both operands, and errors carry `at` at `the`.
func TestOptionalComputedKeyErrors(t *testing.T) {
	// An invalid key with an erroring receiver reports the receiver error.
	r := executeSource(t, "on boom\n return 1 / 0\nend boom\non go\n return the optional (1) of boom()\nend go\n")
	if r.Status != Errored || r.Error.Get("code").Text() != "division by zero" {
		t.Fatalf("receiver error: status=%v error=%s", r.Status, r.Error.Display())
	}
	for _, tc := range []struct{ expression, expected, got, val string }{
		{"the optional (1) of nothing", "text", "number", "1"},
		{"the optional (\"a\") of 5", "map", "number", "5"},
		{"the optional a of [1]", "map", "list", "[1]"},
		{"the optional a of \"x\"", "map", "text", `"x"`},
		{"the optional a of <<1>>", "map", "bytes", "<<0x01>>"},
	} {
		r := executeSource(t, "on go\n return "+tc.expression+"\nend go\n")
		if r.Status != Errored || r.Error.Get("code").Text() != "wrong kind" ||
			r.Error.Get("expected").Text() != tc.expected || r.Error.Get("got").Text() != tc.got ||
			r.Error.Get("value").Display() != tc.val {
			t.Errorf("%s: status=%v error=%s", tc.expression, r.Status, r.Error.Display())
			continue
		}
		if _, ok := r.Error.MapEntry("path"); ok {
			t.Errorf("%s: error carries a fabricated path: %s", tc.expression, r.Error.Display())
		}
		if len(r.Raises) != 1 || r.Raises[0].Instruction.Pos.Line != 2 || r.Raises[0].Instruction.Pos.Column != 9 {
			t.Errorf("%s: raises=%+v, want at 2:9 (the `the`)", tc.expression, r.Raises)
		}
	}
	// Key before receiver, each once.
	counting := "script variable calls = 0\n" +
		"on bump v\n put calls + 1 into calls\n return v\nend bump\n" +
		"on go\n return [the optional (bump(\"a\")) of bump({a: 3}), calls]\nend go\n"
	r = executeSource(t, counting)
	if r.Status != Completed || r.Result.Display() != "[3, 2]" {
		t.Fatalf("computed order: status=%v result=%s", r.Status, r.Result.Display())
	}
}

// Design group 6: Host Objects fail optional reads with no Host crossing,
// live or disposed, while ordinary `id` reads keep working.
func TestOptionalReadsRejectHostObjects(t *testing.T) {
	object := func(disposed bool) value.Value {
		flag := &atomic.Bool{}
		flag.Store(disposed)
		return value.Fields{Kind: value.Object, Object: &value.ObjectData{Kind: "item", ID: "o1", Disposed: flag}}.Value()
	}
	run := func(t *testing.T, source string, args ...value.Value) *Run {
		t.Helper()
		s, e := Initialize(compile(t, source))
		if e != nil {
			t.Fatal(e)
		}
		r := Start(s, 1, args, Limits{Fuel: 10000, Alloc: 10000, Depth: 200, Pattern: 10000})
		r.Execute(0)
		return r
	}
	for _, disposed := range []bool{false, true} {
		for _, expression := range []string{"the optional id of o", "the optional label of o"} {
			r := run(t, "on go o\n return "+expression+"\nend go\n", object(disposed))
			if r.Status != Errored || r.Error.Get("expected").Text() != "map" || r.Error.Get("got").Text() != "object" {
				t.Errorf("%s disposed=%v: status=%v error=%s (Blocked would mean a Host crossing)", expression, disposed, r.Status, r.Error.Display())
			}
		}
	}
	// Ordinary id read unchanged; a Host Object stored in a map may be
	// returned but not stepped into.
	r := run(t, "on go o\n return the id of o\nend go\n", object(false))
	if r.Status != Completed || r.Result.Display() != `"o1"` {
		t.Fatalf("ordinary id: status=%v result=%s", r.Status, r.Result.Display())
	}
	r = run(t, "on go o\n return the optional held of {held: o} is o\nend go\n", object(false))
	if r.Status != Completed || r.Result.Display() != "true" {
		t.Fatalf("held object: status=%v result=%s", r.Status, r.Result.Display())
	}
	r = run(t, "on go o\n return the optional id of the optional held of {held: o}\nend go\n", object(false))
	if r.Status != Errored || r.Error.Get("got").Text() != "object" {
		t.Fatalf("step into object: status=%v error=%s", r.Status, r.Error.Display())
	}
	// branch-not-nothing pushes the same value back, unconverted.
	r = run(t, "on go o\n return (o otherwise nothing) is o\nend go\n", object(false))
	if r.Status != Completed || r.Result.Display() != "true" {
		t.Fatalf("identity: status=%v result=%s", r.Status, r.Result.Display())
	}
}

// Design group 10: a Fuel budget exhausted immediately before the branch
// faults there, charged for neither the branch nor the fallback.
func TestOtherwiseFuelBoundary(t *testing.T) {
	s, e := Initialize(compile(t, "on go\n return nothing otherwise 2\nend go\n"))
	if e != nil {
		t.Fatal(e)
	}
	// The first instruction pays clause 4 + const 1; a budget of 5 then
	// leaves nothing for branch-not-nothing.
	r := Start(s, 1, nil, Limits{Fuel: 5, Alloc: 1000, Depth: 200, Bounded: true})
	r.Execute(0)
	if r.Status != Faulted || r.Limit != "fuel" || r.At.Name != "branch-not-nothing" || r.Fuel != 5 {
		t.Fatalf("status=%v limit=%s at=%s Fuel=%d", r.Status, r.Limit, r.At.Name, r.Fuel)
	}
}

// Design group 8: loader evaluation of Constants and initializers uses
// the same rules, and an error in a selected fallback unwinds cleanly.
func TestNothingDefaultsInitialisersAndUnwind(t *testing.T) {
	r := executeSource(t, "constant x = the optional a of {a: 4} otherwise 0\non go\n return x\nend go\n")
	if r.Status != Completed || r.Result.Display() != "4" {
		t.Fatalf("constant: status=%v result=%s", r.Status, r.Result.Display())
	}
	if _, e := Initialize(compile(t, "constant x = the optional a of 5\non go\n return x\nend go\n")); e == nil {
		t.Fatal("wrong-kind constant initializer accepted at load")
	}
	r = executeSource(t, "on go\n try\n  return nothing otherwise 1 / 0\n catch \"division by zero\"\n  return [1, 2]\n end try\nend go\n")
	if r.Status != Completed || r.Result.Display() != "[1, 2]" {
		t.Fatalf("unwind: status=%v result=%s", r.Status, r.Result.Display())
	}
}

// Design group 7: Guards accept both forms, skip on a runtime wrong kind,
// and record the skip in Raises as a Guard raise.
func TestGuardsWithNothingDefaults(t *testing.T) {
	source := "on pick m where the optional active of m otherwise false\n return 1\nend pick\n" +
		"on pick m where the optional active of m\n return 2\nend pick\n" +
		"on pick m\n return 3\nend pick\n"
	s, e := Initialize(compile(t, source))
	if e != nil {
		t.Fatal(e)
	}
	mk := func(pairs ...value.Pair) value.Value {
		v, err := value.NewMap(pairs)
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	boolVal := func(b bool) value.Value { return value.Fields{Kind: value.Boolean, Bool: b}.Value() }
	for _, tc := range []struct {
		arg   value.Value
		want  string
		guard bool
	}{
		{mk(value.Pair{Key: "active", Val: boolVal(true)}), "1", false},
		{mk(), "3", false},
		{integer(5), "3", true},
	} {
		r := StartDelivery(s, "pick", []value.Value{tc.arg}, Limits{Fuel: 10000, Alloc: 10000, Depth: 200}, false)
		r.Execute(0)
		if r.Status == Dispatching {
			r.AcceptClause(false)
			r.Execute(0)
		}
		if r.Status != Completed || r.Result.Display() != tc.want {
			t.Fatalf("arg=%s: status=%v result=%s, want %s", tc.arg.Display(), r.Status, r.Result.Display(), tc.want)
		}
		if tc.guard && (len(r.Raises) == 0 || !r.Raises[0].Guard) {
			t.Fatalf("arg=%s: want a Guard raise, got %+v", tc.arg.Display(), r.Raises)
		}
	}
}
