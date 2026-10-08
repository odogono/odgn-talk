package session

import (
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestOfferMapKeyEchoReadsBack(t *testing.T) {
	h := New(Environment{})
	for _, source := range []string{":clock virtual 2026-09-30T10:00:00Z", "put {} into m", "put 1 into the offer of m", "put true into the if of m"} {
		if out := h.Input(source); len(out) != 0 {
			t.Fatal(source, out)
		}
	}
	out := h.Input("m")
	if !reflect.DeepEqual(out, []string{`{"offer": 1, if: true}`}) {
		t.Fatal("map echo", out)
	}
	echo := out[0]
	if out := h.Input(echo); !reflect.DeepEqual(out, []string{echo}) {
		t.Fatal("echo as source", out)
	}
	if out := h.Input("(" + echo + ") = m"); !reflect.DeepEqual(out, []string{"true"}) {
		t.Fatal("echo equality", out)
	}
}

func TestEntriesAndAtomicRedefinition(t *testing.T) {
	h := New(Environment{})
	for _, source := range []string{":clock virtual 2026-09-30T10:00:00Z", "put 3 into n", "function twice x\nreturn x * 2\nend twice"} {
		if out := h.Input(source); len(out) != 0 {
			t.Fatal(source, out)
		}
	}
	if out := h.Input("twice(n)"); !reflect.DeepEqual(out, []string{"6"}) {
		t.Fatal(out)
	}
	h.Input("function twice x\nreturn missing\nend twice")
	if out := h.Input("twice(n)"); !reflect.DeepEqual(out, []string{"6"}) {
		t.Fatal(out)
	}
	h.Input("function twice x\nreturn x * 3\nend twice")
	if out := h.Input("twice(n)"); !reflect.DeepEqual(out, []string{"9"}) {
		t.Fatal(out)
	}
}

func TestLabelledHandlerEntries(t *testing.T) {
	h := New(Environment{})
	for _, entry := range []struct {
		source string
		output []string
	}{
		{":clock virtual 2026-09-30T10:00:00Z", nil},
		{"on move x to y\nsay x + y\nend move", nil},
		{"move 3 to 4", []string{"7"}},
		{"on move x toward y\nsay x * y\nend move", nil},
		{"move 3 toward 4", []string{"12"}},
		{"on move x\nsay x\nend move", nil},
		{"move 9", []string{"9"}},
		{"on move x to y\nsay x - y\nend move", nil},
		{"move 5 to 2", []string{"3"}},
		{"move 3 toward 4", []string{"12"}},
		{"move 9", []string{"9"}},
	} {
		if out := h.Input(entry.source); !reflect.DeepEqual(out, entry.output) {
			t.Fatalf("%s: got %v, want %v", entry.source, out, entry.output)
		}
	}
}

func TestVirtualClockIncludesEarliestInstantAndClampsRealReadings(t *testing.T) {
	var records []Item
	h := New(Environment{Now: func() time.Time { return time.Date(1, 1, 1, 0, 0, 0, 0, time.UTC) }, Record: func(i Item) { records = append(records, i) }})
	if out := h.Input(":clock virtual 0001-01-01T00:00:00Z"); len(out) > 0 {
		t.Fatal(out)
	}
	if !h.VirtualClock() {
		t.Fatal("earliest Instant mistaken for absent virtual Clock")
	}
	if out := h.Input("1+1"); !reflect.DeepEqual(out, []string{"2"}) {
		t.Fatal(out)
	}
	for _, i := range records {
		if i.Kind == "clock" {
			t.Fatal("virtual Clock recorded a real reading")
		}
	}
	h.Input(":clock virtual 2026-09-30T10:00:00Z")
	h.Input("1+1")
	h.Input(":clock real")
	h.Input("1+1")
	if out := h.Input(":clock"); !reflect.DeepEqual(out, []string{"real 2026-09-30T10:00:00Z"}) {
		t.Fatal(out)
	}
}
func TestHelpIsOutsideTranscript(t *testing.T) {
	var items []Item
	h := New(Environment{Record: func(i Item) { items = append(items, i) }})
	h.Input(":help")
	h.Input(":quit")
	if len(items) > 0 {
		t.Fatal(items)
	}
}
func TestImplicitBindingsKeepPatternAndLambdaNamesLocal(t *testing.T) {
	h := New(Environment{})
	h.Input(":clock virtual 2026-09-30T10:00:00Z")
	h.Input("if true then\nput 1 into n\nput 2 into a\nend if")
	if h.Source() != "script variable n\nscript variable a\n" {
		t.Fatal(h.Source())
	}
	h.Input("let [x] be [3]")
	if out := h.Input("x"); !reflect.DeepEqual(out, []string{"! unknown name at 1:1"}) {
		t.Fatal(out)
	}
	h.Input("put given\nput 3 into local\nreturn local\nend given into f")
	if strings.Contains(h.Source(), "variable local") {
		t.Fatal(h.Source())
	}
	if out := h.Input("f()"); !reflect.DeepEqual(out, []string{"3"}) {
		t.Fatal(out)
	}
}
func TestSavedStubsAndRejectedLibraryRestore(t *testing.T) {
	h := New(Environment{})
	h.Input(":mock db.get immediate")
	h.Input(":clock virtual 2026-09-30T10:00:00Z")
	h.Input(":stub db.get 7")
	h.Input("function fetch\nask db to get\nreturn it\nend fetch")
	h.Input(":save")
	if out := h.Input("fetch()"); len(out) != 2 || out[1] != "7" {
		t.Fatal(out)
	}
	h.Input(":restore")
	if out := h.Input("fetch()"); len(out) != 2 || out[1] != "7" {
		t.Fatal(out)
	}
	h.Input(":library add l\nconstant c=1")
	h.Input(":save withLibrary")
	h.Input(":library replace l\nconstant c=2")
	if out := h.Input(":restore withLibrary"); !reflect.DeepEqual(out, []string{"! save mismatch"}) {
		t.Fatal(out)
	}
	if out := h.Input("fetch()"); len(out) != 2 || !strings.Contains(out[1], "host error") {
		t.Fatal(out)
	}
}

func TestZeroLimitsAreExplicitOverrides(t *testing.T) {
	for _, tc := range []struct{ limit, entry, expected string }{
		{"fuelPerRun", "1 + 1", "! limit fault fuel"},
		{"allocPerRun", "put \"x\" & \"y\" into n", "! limit fault alloc"},
		{"maxJoin", "wait for all\nsend ping to session and wait\nend wait", "! limit fault join"},
	} {
		t.Run(tc.limit, func(t *testing.T) {
			h := New(Environment{})
			h.Input(":clock virtual 2026-09-30T10:00:00Z")
			h.Input(":limits " + tc.limit + " 0")
			out := h.Input(tc.entry)
			if len(out) == 0 || !strings.HasPrefix(out[len(out)-1], tc.expected) {
				t.Fatal(out)
			}
		})
	}
}
func TestLibraryHandlersAndTransitiveReplacement(t *testing.T) {
	h := New(Environment{})
	h.Input(":clock virtual 2026-09-30T10:00:00Z")
	h.Input(":library add base\nfunction f\nreturn 1\nend f\non greet n\nsay n\nend greet")
	h.Input(":library add wrapper\nuse f, greet from base\nfunction g\nreturn f()\nend g")
	h.Input("use g from wrapper")
	h.Input("use greet from base")
	if out := h.Input("greet \"hello\""); !reflect.DeepEqual(out, []string{"hello"}) {
		t.Fatal(out)
	}
	h.Input(":library replace base\nfunction f\nreturn 2\nend f\non greet n\nsay n\nend greet")
	if out := h.Input("g()"); !reflect.DeepEqual(out, []string{"2"}) {
		t.Fatal(out)
	}
	h.Input(":save")
	if out := h.Input(":restore"); !reflect.DeepEqual(out, []string{"restored default"}) {
		t.Fatal(out)
	}
}
func TestReservedMockOperationIsRefused(t *testing.T) {
	h := New(Environment{})
	if out := h.Input(":mock api.wait immediate"); !reflect.DeepEqual(out, []string{"! bad arguments"}) {
		t.Fatal(out)
	}
	h.Input(":clock virtual 2026-09-30T10:00:00Z")
	if out := h.Input("1"); !reflect.DeepEqual(out, []string{"1"}) {
		t.Fatal(out)
	}
}

func TestReadsKeepCallOrderAndReleaseAbandonedCalls(t *testing.T) {
	h := New(Environment{})
	h.Input(":clock virtual 2026-09-30T10:00:00Z")
	h.Input("on readtwo\nwait for all\nask console to read and wait\nask console to read and wait\nend wait\nsay it\nend readtwo")
	h.Input("readtwo and wait")
	if out := h.Read("alpha"); len(out) > 0 {
		t.Fatal(out)
	}
	if out := h.Read("beta"); !reflect.DeepEqual(out, []string{`["alpha", "beta"]`}) {
		t.Fatal(out)
	}
	h.Input("readtwo and wait")
	h.Input(":cancel")
	if len(h.reads) > 0 || len(h.readOrder) > 0 {
		t.Fatal("abandoned reads retained")
	}
	h2 := New(Environment{})
	h2.Input(":mock api.fetch suspending")
	h2.Input(":clock virtual 2026-09-30T10:00:00Z")
	h2.Input("ask api to fetch and wait")
	h2.Input(":cancel")
	if len(h2.pending) > 0 {
		t.Fatal("abandoned mock retained")
	}
}
func TestLibraryUsesGrantAlias(t *testing.T) {
	h := New(Environment{})
	h.Input(":mock api.get immediate")
	h.Input(":grant alias api")
	h.Input(":clock virtual 2026-09-30T10:00:00Z")
	if out := h.Input(":library add helper\nfunction fetch\nask alias to get\nreturn it\nend fetch"); len(out) > 0 {
		t.Fatal(out)
	}
	h.Input("use fetch from helper")
	h.Input(":stub api.get 5")
	if out := h.Input("fetch()"); len(out) != 2 || out[1] != "5" {
		t.Fatal(out)
	}
}
func TestVariableReinitializationUsesEntryPositions(t *testing.T) {
	h := New(Environment{})
	h.Input(":clock virtual 2026-09-30T10:00:00Z")
	h.Input("script variable x=1")
	if out := h.Input("script variable x = 1 / 0"); !reflect.DeepEqual(out, []string{`! error {code: "division by zero"} at 1:23`}) {
		t.Fatal(out)
	}
	if out := h.Input("x"); !reflect.DeepEqual(out, []string{"1"}) {
		t.Fatal(out)
	}
	if out := h.Input("set me's foo to 3"); len(out) != 1 || strings.Contains(out[0], "unexpected token") {
		t.Fatal(out)
	}
}

func TestFailedDependentReplacementIsTracedAndAtomic(t *testing.T) {
	var trace []string
	h := New(Environment{Trace: func(line string) { trace = append(trace, line) }})
	h.Input(":clock virtual 2026-09-30T10:00:00Z")
	h.Input(":library add base\nfunction f\nreturn 1\nend f")
	h.Input(":library add wrapper\nuse f from base\nfunction g\nreturn f()\nend g")
	h.Input("use g from wrapper")
	trace = nil
	out := h.Input(":library replace base\nfunction other\nreturn 2\nend other")
	if len(out) == 0 {
		t.Fatal("replacement should reject broken dependent")
	}
	if len(trace) == 0 || !strings.HasPrefix(trace[0], "> replace-library base") {
		t.Fatal("replacement Host Input missing", trace)
	}
	if out := h.Input("g()"); !reflect.DeepEqual(out, []string{"1"}) {
		t.Fatal(out)
	}
}

func TestClockAdvanceRoundsFractionalNanosecondsHalfEven(t *testing.T) {
	h := New(Environment{})
	h.Input(":clock virtual 2026-09-30T10:00:00Z")
	for _, source := range []string{":clock advance 0.0000000005 s", ":clock advance 0.0000000015 s", ":clock advance 0.0000000025 s"} {
		if out := h.Input(source); len(out) > 0 {
			t.Fatal(source, out)
		}
	}
	if out := h.Input(":clock"); !reflect.DeepEqual(out, []string{"virtual 2026-09-30T10:00:00.000000004Z"}) {
		t.Fatal(out)
	}
}
func TestLibraryPreservesTrailingSourceSpaces(t *testing.T) {
	h := New(Environment{})
	h.Input(":clock virtual 2026-09-30T10:00:00Z")
	h.Input(":library add lib\nconstant c=1   ")
	if got := h.UserLibraries()[0].Source; got != "constant c=1   \n" {
		t.Fatalf("source=%q", got)
	}
}

func TestClockAdvanceRejectsNegativeFractionBeforeRounding(t *testing.T) {
	h := New(Environment{})
	h.Input(":clock virtual 2026-09-30T10:00:00Z")
	if out := h.Input(":clock advance -0.0000000001 s"); !reflect.DeepEqual(out, []string{"! bad arguments"}) {
		t.Fatal(out)
	}
}
