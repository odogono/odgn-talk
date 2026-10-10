package machine

import (
	"maps"
	"os"
	"reflect"
	"slices"
	"testing"

	"github.com/odogono/odgn-talk/impl/go/internal/check"
	"github.com/odogono/odgn-talk/impl/go/internal/lower"
	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
	"github.com/odogono/odgn-talk/impl/go/internal/value"
)

func compile(t *testing.T, source string) *lower.Unit {
	t.Helper()
	tree, err := syntax.Parse(source)
	if err != nil {
		t.Fatal(err)
	}
	unit, err := lower.Compile(check.Check(tree, check.Options{}), "test")
	if err != nil {
		t.Fatal(err)
	}
	return unit
}
func TestRunCanPreemptAndResume(t *testing.T) {
	unit := compile(t, "script variable result\non go\n put 2 + 3 into result\n return result\nend go\n")
	state, err := Initialize(unit)
	if err != nil {
		t.Fatal(err)
	}
	run := Start(state, 1, nil, Limits{Fuel: 1000, Alloc: 1000, Depth: 200})
	for run.Status == Running || run.Status == Preempted {
		run.Execute(1)
	}
	if run.Status != Completed || run.Result.Display() != "5" || state.Variables[0].Display() != "5" {
		t.Fatalf("%+v", run)
	}
	// clause 4 + const 1 + const 1 + add 4 + store-var 2 + load-var 1 + return 2.
	if run.Fuel != 15 || run.Alloc != 16 {
		t.Fatalf("fuel=%d alloc=%d", run.Fuel, run.Alloc)
	}
}
func TestLimitFaultChargesNeitherInstructionNorPartialWrite(t *testing.T) {
	unit := compile(t, "script variable result = 9\non go\n put 5 into result\n put 2 + 3 into result\nend go\n")
	state, err := Initialize(unit)
	if err != nil {
		t.Fatal(err)
	}
	run := Start(state, 1, nil, Limits{Fuel: 10, Alloc: 1000, Depth: 200})
	run.Execute(0)
	if run.Status != Faulted || run.Limit != "fuel" || run.Fuel != 9 || state.Variables[0].Display() != "9" {
		t.Fatalf("%+v vars=%v", run, state.Variables)
	}
}

// An instruction that can't pay leaves its frame as it found it, whatever it
// popped, pushed, stored or jumped before the charge.
func TestFailedChargeLeavesTheFrameUnchanged(t *testing.T) {
	unit := compile(t, "function step acc, i\n return acc + i\nend step\non go n\n put 0 into total\n repeat for each i in 1..n\n  put step(total, i) into total\n end repeat\n return total\nend go\n")
	state, err := Initialize(unit)
	if err != nil {
		t.Fatal(err)
	}
	type snapshot struct {
		depth, pc     int
		waiting       bool
		stack, locals []value.Value
		names         map[int]string
	}
	take := func(r *Run) snapshot {
		f := r.Frames[len(r.Frames)-1]
		return snapshot{len(r.Frames), f.PC, f.Waiting, slices.Clone(f.Stack), slices.Clone(f.Locals), maps.Clone(f.ReceiverNames)}
	}
	faults := 0
	for fuel := int64(0); ; fuel++ {
		r := Start(state, 2, []value.Value{integer(3)}, Limits{Fuel: fuel, Alloc: 1000, Depth: 200, Bounded: true})
		var before snapshot
		for r.Status == Running || r.Status == Preempted {
			before = take(r)
			r.Execute(1)
		}
		if r.Status == Completed {
			break
		}
		if r.Status != Faulted || r.Limit != "fuel" {
			t.Fatalf("fuel %d: %v %q", fuel, r.Status, r.Limit)
		}
		if after := take(r); !reflect.DeepEqual(before, after) {
			t.Fatalf("fuel %d at %s: frame changed from %+v to %+v", fuel, r.At.Name, before, after)
		}
		faults++
	}
	if faults < 20 {
		t.Fatalf("only %d faults", faults)
	}
}
func TestGeneratedRatesAndSizes(t *testing.T) {
	text, _ := value.NewText("q\u0301")
	list := value.NewList([]value.Value{text, text})
	if Size(list) != 70 {
		t.Fatalf("size=%d", Size(list))
	}
	fuel, alloc := Charge("concat", Measures{Result: text})
	if fuel != 4 || alloc != 19 {
		t.Fatalf("%d %d", fuel, alloc)
	}
}

func TestDeferredInstructionIsAnUnchargedBoundary(t *testing.T) {
	unit := compile(t, "on go\n ask prices to lookup 1\nend go\n")
	s, e := Initialize(unit)
	if e != nil {
		t.Fatal(e)
	}
	r := Start(s, 1, nil, Limits{Fuel: 1000, Alloc: 1000, Depth: 200})
	r.Execute(0)
	if r.Status != Blocked || r.At.Name != "ask" || r.Fuel != 5 || r.Alloc != 0 || len(r.Raises) != 0 {
		t.Fatalf("%+v", r)
	}
	f := r.Frames[0]
	if len(f.Stack) != 1 || f.Stack[0].Display() != "1" || f.PC != 1 {
		t.Fatal(f)
	}
}
func TestCatchUnwindsAtTheCallerInstruction(t *testing.T) {
	unit := compile(t, "script variable result\nfunction fail\n throw \"example\"\nend fail\non go\n try\n  put fail() into result\n catch \"example\"\n  put 42 into result\n end try\nend go\n")
	s, e := Initialize(unit)
	if e != nil {
		t.Fatal(e)
	}
	r := Start(s, 2, nil, Limits{Fuel: 1000, Alloc: 1000, Depth: 200})
	r.Execute(0)
	if r.Status != Completed || s.Variables[0].Display() != "42" {
		t.Fatalf("%+v", r)
	}
}
func TestBuiltinDomainErrorsAndFields(t *testing.T) {
	for _, tc := range []struct {
		name  string
		input value.Value
	}{{"codePoint", text("")}, {"codePoint", text("q\u0301")}, {"fromCodePoint", integer(0xd800)}, {"fromCodePoint", func() value.Value { n, _ := constant("1.5"); return n }()}, {"min", value.NewList(nil)}} {
		t.Run(tc.name+tc.input.Display(), func(t *testing.T) {
			_, e := builtin(tc.name, []value.Value{tc.input}, &Measures{})
			if e == nil || e.Get("code").Text() != "out of domain" || e.Get("function").Text() != tc.name || !e.Get("value").Equal(tc.input) {
				t.Fatalf("%v", e)
			}
		})
	}
}
func TestWrongKindRetainsOffendingValue(t *testing.T) {
	e := wrong("number", text("3"))
	if e.Get("value").Text() != "3" || e.Get("got").Text() != "text" {
		t.Fatal(e)
	}
}
func TestNormativePatternStepsAndCaptures(t *testing.T) {
	for _, tc := range []struct {
		source  string
		steps   int64
		matched string
	}{{`<"$", digits>`, 10, "$895"}, {`<"$", digits lazily>`, 6, "$8"}, {`<n: a number>`, 0, "-12.5"}} {
		v, e := value.ParsePattern(tc.source)
		if e != nil {
			t.Fatal(e)
		}
		p, e := compilePattern(v, false)
		if e != nil {
			t.Fatal(e)
		}
		subject := "$895"
		if tc.steps == 0 {
			subject = "-12.5"
		}
		match, steps := search(p, subject, 0, "search", false)
		if match == nil {
			t.Fatalf("no match: %s", tc.source)
		}
		got, scriptErr := matchValue(p, subject, match)
		if scriptErr != nil {
			t.Fatal(scriptErr)
		}
		if got.Get("text").Text() != tc.matched || tc.steps > 0 && steps != tc.steps {
			t.Fatalf("%s %d", got.Display(), steps)
		}
		if tc.steps == 0 && got.Get("captures").Get("n").Display() != "-12.5" {
			t.Fatal(got.Display())
		}
	}
}

func TestFinallyRunsBeforeAnOuterCatch(t *testing.T) {
	unit := compile(t, "script variable result = []\non go\n try\n  try\n   throw \"first\"\n  finally\n   put 1 after result\n  end try\n catch \"first\"\n  put 2 after result\n end try\nend go\n")
	s, e := Initialize(unit)
	if e != nil {
		t.Fatal(e)
	}
	r := Start(s, 1, nil, Limits{Fuel: 10000, Alloc: 10000, Depth: 200})
	r.Execute(0)
	if r.Status != Completed || s.Variables[0].Display() != "[1, 2]" || len(r.Cleanup) != 0 {
		t.Fatalf("%+v vars=%s", r, s.Variables[0].Display())
	}
}
func TestFinallyReplacementKeepsTheOriginalError(t *testing.T) {
	unit := compile(t, "on go\n try\n  throw \"first\"\n finally\n  throw \"second\"\n end try\nend go\n")
	s, e := Initialize(unit)
	if e != nil {
		t.Fatal(e)
	}
	r := Start(s, 1, nil, Limits{Fuel: 10000, Alloc: 10000, Depth: 200})
	r.Execute(0)
	if r.Status != Errored || r.Error.Get("code").Text() != "second" || r.Error.Get("during").Get("code").Text() != "first" || len(r.Cleanup) != 0 {
		t.Fatalf("%+v", r)
	}
}
func TestPatternLimitPrecedesFuel(t *testing.T) {
	unit := compile(t, "on go\n put \"abcdef\" into p\n put <(p)> into result\nend go\n")
	s, e := Initialize(unit)
	if e != nil {
		t.Fatal(e)
	}
	r := Start(s, 1, nil, Limits{Fuel: 8, Alloc: 10000, Depth: 200, Pattern: 3})
	r.Execute(0)
	if r.Status != Faulted || r.Limit != "pattern" || r.Fuel != 7 || r.Alloc != 0 {
		t.Fatalf("%+v", r)
	}
}
func TestAbsentInstructionResultDoesNotAllocateNothing(t *testing.T) {
	fuel, alloc := Charge("arithmetic", Measures{})
	if fuel != 3 || alloc != 0 {
		t.Fatalf("%d %d", fuel, alloc)
	}
	_, alloc = Charge("operator", Measures{ResultPresent: true})
	if alloc != 8 {
		t.Fatal(alloc)
	}
}
func TestAllocationFaultAndPersistentEndCheck(t *testing.T) {
	unit := compile(t, "script variable result\non go\n put [1, 2] into result\nend go\n")
	for _, tc := range []struct {
		limits Limits
		limit  string
		fuel   int64
	}{{Limits{Fuel: 1000, Alloc: 40, Depth: 200}, "alloc", 6}, {Limits{Fuel: 1000, Alloc: 1000, Persistent: 40, Depth: 200}, "persistent", 14}} {
		s, e := Initialize(unit)
		if e != nil {
			t.Fatal(e)
		}
		r := Start(s, 1, nil, tc.limits)
		r.Execute(0)
		if r.Status != Faulted || r.Limit != tc.limit || r.Fuel != tc.fuel || s.Variables[0].Kind != value.Nothing {
			t.Fatalf("%+v", r)
		}
	}
}
func TestPaddingCannotAllocateBeforeAnUnpayableCharge(t *testing.T) {
	unit := compile(t, "on go\n put \"a\" into s\n put \"z\" into item 999999999999999999999999999999999 of s\nend go\n")
	s, e := Initialize(unit)
	if e != nil {
		t.Fatal(e)
	}
	r := Start(s, 1, nil, Limits{Fuel: 100, Alloc: 1000, Depth: 200})
	r.Execute(0)
	if r.Status != Faulted || r.Limit != "fuel" || r.At.Name != "chunk-set" {
		t.Fatalf("%+v", r)
	}
}

func executeSource(t *testing.T, source string) *Run {
	t.Helper()
	s, e := Initialize(compile(t, source))
	if e != nil {
		t.Fatal(e)
	}
	body := 1
	for _, b := range s.Unit.Bodies {
		if b.Checked.Kind == "handler" && b.Checked.Name == "go" {
			body = b.Index
			break
		}
	}
	r := Start(s, body, nil, Limits{Fuel: 10000, Alloc: 10000, Depth: 200, Pattern: 10000})
	r.Execute(0)
	return r
}
func TestTemplatePlaceholdersOnlyReplaceOriginalSplices(t *testing.T) {
	r := executeSource(t, "on go\n return \"(1)\"\nend go\n")
	if r.Status != Completed || r.Result.Kind != value.Text || r.Result.Text() != "(1)" {
		t.Fatalf("%+v", r)
	}
	for _, source := range []string{
		"on go\n put \"x\" into p\n return \"(1)x\" matches <\"(1)\", (p)>\nend go\n",
		"on go\n put \"(2)\" into p\n put \"x\" into q\n return \"(2)x\" matches <(p), (q)>\nend go\n",
		"on go\n put quote & newline into p\n return p matches <(p)>\nend go\n",
	} {
		r := executeSource(t, source)
		if r.Status != Completed || !r.Result.Bool {
			t.Fatalf("%s: %+v", source, r)
		}
	}
}
func TestRangeIterationAndNegativeRepeat(t *testing.T) {
	for _, tc := range []struct{ rangeText, want string }{{"1..3", "[1, 2, 3]"}, {"3..1", "[]"}, {"999999999999999999999999999999997..999999999999999999999999999999999", "[999999999999999999999999999999997, 999999999999999999999999999999998, 999999999999999999999999999999999]"}} {
		r := executeSource(t, "on go\n put [] into result\n repeat for each x in "+tc.rangeText+"\n  put x after result\n end repeat\n return result\nend go\n")
		if r.Status != Completed || r.Result.Display() != tc.want {
			t.Fatalf("%+v result=%s", r, r.Result.Display())
		}
	}
	r := executeSource(t, "on go\n repeat -1 times\n end repeat\nend go\n")
	if r.Status != Errored || r.Error.Get("code").Text() != "out of range" || r.Error.Get("field").Text() != "count" {
		t.Fatalf("%+v", r)
	}
	r = executeSource(t, "on go\n repeat 999999999999999999999999999999999 times\n  return 7\n end repeat\nend go\n")
	if r.Status != Completed || r.Result.Display() != "7" {
		t.Fatalf("%+v", r)
	}
}
func TestMissingChunkScansAllCharacters(t *testing.T) {
	for _, kind := range []string{"word", "line", "item"} {
		_, scanned, exists, e := chunk("chunk-get", kind, integer(2), text("abcdefghijklmnop"), value.Value{}, text(","))
		if e != nil || exists || scanned != 16 {
			t.Fatalf("%s %d %v %v", kind, scanned, exists, e)
		}
	}
}
func TestLinesRecognizeCRAndCRLF(t *testing.T) {
	v, e := property("lines", text("a\r\nb\rc\n"), text(","))
	if e != nil || v.Display() != `["a", "b", "c"]` {
		t.Fatalf("%s %v", v.Display(), e)
	}
	v, _, _, e = chunk("chunk-delete", "line", integer(2), text("a\r\nb\rc"), value.Value{}, text(","))
	if e != nil || v.Text() != "a\r\nc" {
		t.Fatalf("%s %v", v.Display(), e)
	}
}

func TestDeferredOperandsRemainUntouched(t *testing.T) {
	r := executeSource(t, "on go\n ask prices to lookup 1\nend go\n")
	if r.Status != Blocked || len(r.Frames) != 1 || len(r.Frames[0].Stack) != 1 || len(r.Raises) != 0 {
		t.Fatalf("%+v", r)
	}
}
func TestWrongPatternKindRaisesRatherThanPanics(t *testing.T) {
	r := executeSource(t, "on go\n return \"abc\" matches 3\nend go\n")
	if r.Status != Errored || r.Error.Get("code").Text() != "wrong kind" {
		t.Fatalf("%+v", r)
	}
}
func TestCountedWordsSeparateEachWord(t *testing.T) {
	r := executeSource(t, "on go\n return \"one two\" matches <2 words>\nend go\n")
	if r.Status != Completed || !r.Result.Bool {
		t.Fatalf("%+v", r)
	}
}
func TestRangeMeasuresAreEmptyOrSaturating(t *testing.T) {
	for _, tc := range []struct {
		source string
		want   int64
	}{{"3..1", 0}, {"1..3", 3}, {"-999999999999999999999999999999999..999999999999999999999999999999999", 9223372036854775807}} {
		v, e := constant(tc.source)
		if e != nil {
			t.Fatal(e)
		}
		if got := measure("items", v); got != tc.want {
			t.Fatalf("%s: %d", tc.source, got)
		}
	}
}
func TestThrowPreservesAnExistingAtKey(t *testing.T) {
	r := executeSource(t, "on go\n throw {code: \"example\", at: nothing}\nend go\n")
	if r.Status != Errored || len(r.Error.Entries()) != 2 || r.Error.Get("at").Kind != value.Nothing {
		t.Fatalf("%+v", r)
	}
}
func TestPatternCompilerBoundsCountedExpansion(t *testing.T) {
	for _, source := range []string{`<999999999999999999999999999999999 digits>`, `<1000 <1000 digits>>`} {
		v, e := value.ParsePattern(source)
		if e != nil {
			t.Fatal(e)
		}
		if _, e = compilePattern(v, false); e == nil {
			t.Fatal("accepted oversized program")
		}
	}
}

func TestPaddingPreflightCountsOnlyRetainedPadding(t *testing.T) {
	unit := compile(t, "on go\n put \"a\" into s\n put \"z\" into items 1..9223372036854775807 of s\n return s\nend go\n")
	s, e := Initialize(unit)
	if e != nil {
		t.Fatal(e)
	}
	r := Start(s, 1, nil, Limits{Fuel: 100, Alloc: 1000, Depth: 200})
	r.Execute(0)
	if r.Status != Completed || r.Result.Text() != "z" {
		t.Fatalf("%+v", r)
	}
}
func TestPaddingPreflightAtInt64Ceiling(t *testing.T) {
	unit := compile(t, "on go\n put \"a\" into s\n put \"z\" into item 9223372036854775807 of s\nend go\n")
	s, e := Initialize(unit)
	if e != nil {
		t.Fatal(e)
	}
	r := Start(s, 1, nil, Limits{Fuel: 100, Alloc: 1000, Depth: 200})
	r.Execute(0)
	if r.Status != Faulted || r.Limit != "fuel" {
		t.Fatalf("%+v", r)
	}
}

func TestRaiseUsesCanonicalUnitInstructionIndex(t *testing.T) {
	source, e := os.ReadFile("../../../../corpus/text-model/chunk-write-out-of-range/writes.talk")
	if e != nil {
		t.Fatal(e)
	}
	r := executeSource(t, string(source))
	if r.Status != Completed || len(r.Raises) != 5 || r.Raises[0].PC != 13 || r.Raises[0].Instruction.Pos.Line != 16 {
		t.Fatalf("%+v", r)
	}
}
func TestLineAnchorsRecognizeAllLineEndings(t *testing.T) {
	for _, separator := range []string{"\r", "\n", "\r\n"} {
		v, e := value.ParsePattern(`<line start, "b", line end>`)
		if e != nil {
			t.Fatal(e)
		}
		p, e := compilePattern(v, false)
		if e != nil {
			t.Fatal(e)
		}
		if m, _ := search(p, "a"+separator+"b"+separator+"c", 0, "search", false); m == nil {
			t.Fatal("missed line: ", separator)
		}
	}
}

func TestLinePaddingPreservesAnExistingTrailingBreak(t *testing.T) {
	for _, separator := range []string{"\r", "\n", "\r\n"} {
		v, _, _, e := chunk("chunk-set", "line", integer(2), text("a"+separator), text("b"), text(","))
		if e != nil || v.Text() != "a"+separator+"b" {
			t.Fatalf("%s %v", v.Display(), e)
		}
	}
}
