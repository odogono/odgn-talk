package check

import (
	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
)

func TestLoadDiagnostics(t *testing.T) {
	for _, tc := range []struct {
		source, code string
		line, column int
	}{
		{"on t\nreturn absent\nend", "unknown name", 2, 8},
		{"on t\nreturn min\nend", "not a value", 2, 8},
		{"constant x = 1\non t x\nend", "name clash", 2, 6},
		{"on t\nlet [x, x] be []\nend", "duplicate name", 2, 9},
		{"on t\nreturn {a: 1, a: 2}\nend", "duplicate key", 2, 15},
		{"on t x\nreturn x is a bogus\nend", "unknown kind", 2, 15},
		{"on t x\nreturn x as list\nend", "no conversion", 2, 10},
		{"constant x = 10000000000000000000000000000000000", "bad number", 1, 14},
		{"on t\nreturn <10000 digit>\nend", "pattern too large", 2, 8},
		{"function f x\nreturn x\nend\non t\nreturn f()\nend", "wrong argument count", 5, 8},
		{"private constant x = 1", "not in a script", 1, 1},
		{"on t\nput given: the target into f\nend", "not in a lambda", 2, 12},
		{"function f x\nreturn x\nend\non t x where f(x)\nend", "not in a guard", 4, 14},
		{"on t\nwait for all\nreturn 1\nend\nend", "not in a join", 3, 1},
		{"on t\nwait for all\nend\nend", "empty join", 2, 1},
		{"on b\nwait 1 s\nend\non t\nwith timeout of 1 s\nb and wait\nwait 1 s\nend\nend", "not in a timeout", 6, 1},
		{"on t\nwith timeout of 1 s\nput given\nwait 1 s\nend given into f\nend\nend", "empty timeout", 2, 1},
		{"on t\nwait for all\nwith timeout of 1 s\nsend x to me and wait\nend\nend\nend", "empty timeout", 3, 1},
		{"on t\ntry\nfinally\nreturn 1\nend\nend", "leaves finally", 4, 1},
		{"on t\nexit repeat\nend", "outside a loop", 2, 1},
		{"constant x = 1\non t\nput 2 into x\nend", "can't write", 3, 12},
		{"on t x\nset x to 1\nend", "not a property", 2, 1},
		{"script variable x = 1\nconstant y = x", "not constant", 2, 14},
		{"function f a = 1, b\nend", "default order", 1, 19},
		{"on t x\nreturn x is a number ignoring case\nend", "nothing to fold", 2, 22},
		{"on t x\nreturn word 1 of x delimited by \",\"\nend", "no item chunk", 2, 20},
		{"on t\nreturn <optional n: digit>\nend", "capture in repetition", 2, 18},
		{"on t\nlet [...xs, x] be []\nend", "rest not last", 2, 6},
		{"on t\nreturn <<1 as 3 bits>>\nend", "bits not whole bytes", 2, 10},
	} {
		tree, err := syntax.Parse(tc.source)
		if err != nil {
			t.Fatalf("%s: %v", tc.code, err)
		}
		checked := Check(tree, Options{})
		found := false
		for _, diag := range checked.Diagnostics {
			if diag.Code == tc.code && diag.Pos == (syntax.Position{Line: tc.line, Column: tc.column}) {
				found = true
			}
		}
		if !found {
			t.Errorf("%s: got %v, want %d:%d", tc.code, checked.Diagnostics, tc.line, tc.column)
		}
	}
}

func TestBodySlotsAndCaptures(t *testing.T) {
	tree, err := syntax.Parse("on t [x, y], limit\nput given z: x + z + limit into f\nreturn f\nend")
	if err != nil {
		t.Fatal(err)
	}
	checked := Check(tree, Options{})
	if len(checked.Diagnostics) > 0 {
		t.Fatal(checked.Diagnostics)
	}
	body := checked.Bodies[tree.Declarations[0]]
	if got := body.Locals; len(got) != 6 || got[0] != "it" || got[1] != "(1)" || got[2] != "limit" || got[3] != "x" || got[4] != "y" || got[5] != "f" {
		t.Fatal(got)
	}
	lambda := tree.Declarations[0].Body[0].Children[0]
	captured := checked.Bodies[lambda]
	if len(captured.Captures) != 2 || captured.Captures[0].Name != "x" || captured.Captures[1].Name != "limit" {
		t.Fatal(captured.Captures)
	}
}

func TestRejectedBindingsAndBinarySizes(t *testing.T) {
	for _, source := range []string{
		"constant x = 1\nfunction f x\nreturn x\nend",
		"constant x = 1\non t\nlet x be 2\nend",
		"function f\nend\non t\nput 1 into f\nend",
		"on t\nlet <<data: bogus bytes>> be <<>>\nend",
		"on t\nlet <<data: n bytes, n: uint8>> be <<>>\nend",
		"on t\nreturn given [x, x]: x\nend",
		"on t x\nput given\nput 1 into x\nend into f\nend",
	} {
		tree, err := syntax.Parse(source)
		if err != nil {
			t.Fatal(err)
		}
		u := Check(tree, Options{})
		if len(u.Diagnostics) == 0 {
			t.Errorf("accepted invalid bindings: %s", source)
		}
	}
}
func TestNestedLambdaShadowing(t *testing.T) {
	tree, err := syntax.Parse("on t x\nreturn given: given x: x\nend")
	if err != nil {
		t.Fatal(err)
	}
	u := Check(tree, Options{})
	if len(u.Diagnostics) > 0 {
		t.Fatal(u.Diagnostics)
	}
	outer := tree.Declarations[0].Body[0].Children[0]
	if len(u.Bodies[outer].Captures) != 0 {
		t.Fatal(u.Bodies[outer].Captures)
	}
}

func TestReviewDiagnosticPositions(t *testing.T) {
	for _, tc := range []struct {
		source, code string
		line, col    int
	}{
		{"on t\nlet [x] as x be []\nend", "duplicate name", 2, 12},
		{"function f a\nend\nfunction f b\nend", "name clash", 3, 10},
		{"on t\nreturn <digit as bogus>\nend", "unknown kind", 2, 18},
		{"on t\nreturn <digit as list>\nend", "no conversion", 2, 15},
	} {
		tree, err := syntax.Parse(tc.source)
		if err != nil {
			t.Fatal(err)
		}
		u := Check(tree, Options{})
		found := false
		for _, d := range u.Diagnostics {
			if d.Code == tc.code && d.Pos == (syntax.Position{Line: tc.line, Column: tc.col}) {
				found = true
			}
		}
		if !found {
			t.Errorf("%s: %v", tc.code, u.Diagnostics)
		}
	}
}
func TestBindingSitesFollowSourceOrder(t *testing.T) {
	tree, err := syntax.Parse("on t\nif true then\nput 1 into a\nelse\nput 2 into b\nend\nreturn a + b\nend")
	if err != nil {
		t.Fatal(err)
	}
	u := Check(tree, Options{})
	slots := u.Bodies[tree.Declarations[0]].Locals
	if len(slots) != 3 || slots[1] != "a" || slots[2] != "b" {
		t.Fatal(slots)
	}
}

func TestTransitivePinCaptures(t *testing.T) {
	tree, err := syntax.Parse("on t x\nreturn given: given ^x: 1\nend")
	if err != nil {
		t.Fatal(err)
	}
	u := Check(tree, Options{})
	if len(u.Diagnostics) > 0 {
		t.Fatal(u.Diagnostics)
	}
	outer := tree.Declarations[0].Body[0].Children[0]
	if len(u.Bodies[outer].Captures) != 1 {
		t.Fatal(u.Bodies[outer].Captures)
	}
}
func TestBranchCaptureOrder(t *testing.T) {
	tree, err := syntax.Parse("on t a, b\nreturn given\nif true then\nreturn a\nelse\nreturn b\nend\nend\nend")
	if err != nil {
		t.Fatal(err)
	}
	u := Check(tree, Options{})
	outer := tree.Declarations[0].Body[0].Children[0]
	c := u.Bodies[outer].Captures
	if len(c) != 2 || c[0].Name != "a" || c[1].Name != "b" {
		t.Fatal(c)
	}
}
func TestExpressionReadsAreNotBindings(t *testing.T) {
	for _, source := range []string{"on t\nreturn replace p in \"abc\" with \"z\"\nend", "on t\nlet <<n: uint8, data: (absent(n)) bytes>> be <<>>\nend"} {
		tree, err := syntax.Parse(source)
		if err != nil {
			t.Fatal(err)
		}
		u := Check(tree, Options{})
		found := false
		for _, d := range u.Diagnostics {
			if d.Code == "unknown name" {
				found = true
			}
		}
		if !found {
			t.Fatal(u.Diagnostics)
		}
	}
}

func TestReviewEdgeCases(t *testing.T) {
	for _, tc := range []struct {
		source, code string
		line, col    int
	}{
		{"on t\nlet <<10000000000000000000000000000000000>> be <<>>\nend", "bad number", 2, 7},
		{"on t\nlet ^missing be 1\nend", "unknown name", 2, 6},
		{"function f x\nreturn x\nend\nconstant x = 1", "name clash", 4, 10},
		{"on t\nreturn <1000000000 1000000000 1000000000 digit>\nend", "pattern too large", 2, 8},
		{"on t\nlet [<10000 digit>] be []\nend", "pattern too large", 2, 6},
	} {
		tree, err := syntax.Parse(tc.source)
		if err != nil {
			t.Fatal(err)
		}
		u := Check(tree, Options{})
		found := false
		for _, d := range u.Diagnostics {
			if d.Code == tc.code && d.Pos == (syntax.Position{Line: tc.line, Column: tc.col}) {
				found = true
			}
		}
		if !found {
			t.Errorf("%s: %v", tc.source, u.Diagnostics)
		}
	}
	for _, source := range []string{"on t\nput replace <x: letter> in \"abc\" with x into y\nend", "on t\nreplace <x: letter> in y with x\nend"} {
		tree, err := syntax.Parse(source)
		if err != nil {
			t.Fatal(err)
		}
		u := Check(tree, Options{})
		slots := u.Bodies[tree.Declarations[0]].Locals
		if len(slots) != 3 || slots[1] != "x" || slots[2] != "y" {
			t.Fatal(slots)
		}
	}
}

// These cases' first blessings were approved for #141.
// The worker Trace replay joins #249; here the checker pins every diag record,
// for each Script of the case, by its source file's name.
func TestLoadDiagnosticCorpus(t *testing.T) {
	files, err := filepath.Glob("../../../../corpus/load-diagnostics/*/case.trace")
	if err != nil {
		t.Fatal(err)
	}
	record := regexp.MustCompile(`(?m)^diag (\S+) code="([^"]+)" pos=(\d+):(\d+)$`)
	for _, file := range files {
		if strings.Contains(file, "initialiser-failed/") {
			continue
		} // Executed in lower's initializer boundary test.
		if strings.Contains(file, "object-properties/") {
			continue // Declaration-backed checks run through the embedding in corpus.TestObjectPropertyAcceptance.
		}
		t.Run(filepath.Base(filepath.Dir(file)), func(t *testing.T) {
			trace, err := os.ReadFile(file)
			if err != nil {
				t.Fatal(err)
			}
			expected := map[string][]Diagnostic{}
			for _, match := range record.FindAllStringSubmatch(string(trace), -1) {
				line, _ := strconv.Atoi(match[3])
				column, _ := strconv.Atoi(match[4])
				expected[match[1]] = append(expected[match[1]], Diagnostic{Code: match[2], Pos: syntax.Position{Line: line, Column: column}})
			}
			if len(expected) == 0 {
				t.Fatal("case has no diagnostic records")
			}
			sources, _ := filepath.Glob(filepath.Join(filepath.Dir(file), "*.talk"))
			for _, path := range sources {
				name := strings.TrimSuffix(filepath.Base(path), ".talk")
				source, err := os.ReadFile(path)
				if err != nil {
					t.Fatal(err)
				}
				tree, parseErr := syntax.Parse(string(source))
				var actual []Diagnostic
				if parseErr != nil {
					e, ok := parseErr.(*syntax.Error)
					if !ok {
						t.Fatal(parseErr)
					}
					actual = []Diagnostic{{Code: e.Code, Pos: e.Pos}}
				} else {
					actual = Check(tree, Options{}).Diagnostics
				}
				if !slices.Equal(actual, expected[name]) {
					t.Fatalf("%s: expected %v, got %v", name, expected[name], actual)
				}
			}
		})
	}
}

// The Fallback Handler's load rules (ADR 0064).
func TestFallbackHandlerDiagnostics(t *testing.T) {
	for _, tc := range []struct {
		source, code string
		line, col    int
		library      bool
	}{
		{"on any message m\n pass any message\nend any message", "", 0, 0, false},
		{"on any message m, queued\n send (the name of m) with ...(the args of m) to me\nend", "", 0, 0, false},
		{"on any message m, during e\nend", "bad suffixes", 1, 19, false},
		{"on any message m, dropping, deciding\nend", "bad suffixes", 1, 29, false},
		{"on any message m\n pass go\nend", "wrong message", 2, 7, false},
		{"on go\n pass any message\nend go", "wrong message", 2, 7, false},
		{"function f\n pass any message\nend f", "wrong message", 2, 7, false},
		{"on any message m\n put given x\n  pass any message\n end given into f\nend", "not in a lambda", 3, 3, false},
		{"on any message m\n veto\nend", "veto outside a decision", 2, 2, false},
		{"on any message m\nend", "not in a library", 1, 1, true},
		{"on any x\n pass any\nend any", "", 0, 0, false},
	} {
		t.Run(tc.source, func(t *testing.T) {
			tree, err := syntax.Parse(tc.source)
			if err != nil {
				t.Fatal(err)
			}
			u := Check(tree, Options{Library: tc.library})
			if tc.code == "" {
				if len(u.Diagnostics) != 0 {
					t.Fatal(u.Diagnostics)
				}
				return
			}
			want := Diagnostic{Code: tc.code, Pos: syntax.Position{Line: tc.line, Column: tc.col}}
			if len(u.Diagnostics) == 0 || u.Diagnostics[0] != want {
				t.Fatalf("want %v, got %v", want, u.Diagnostics)
			}
		})
	}
}

func TestErrorDuringBindingAndSuffixDiagnostics(t *testing.T) {
	for _, tc := range []struct {
		source, code string
		line, col    int
	}{
		{"on error e where the name of msg = \"go\", during msg\nreturn given: msg\nend", "", 0, 0},
		{"on error e, during during, dropping\nreturn during\nend", "", 0, 0},
		{"on go e, during msg\nend", "bad suffixes", 1, 10},
		{"on error e, queued, dropping\nend", "bad suffixes", 1, 21},
		{"on error e, deciding, queued\nend", "bad suffixes", 1, 23},
		{"on error e, queued, deciding\nend", "bad suffixes", 1, 21},
		{"on error e, during msg, during other\nend", "bad suffixes", 1, 25},
		{"constant msg = 1\non error e, during msg\nend", "name clash", 2, 20},
		{"on error msg, during msg\nend", "duplicate name", 1, 22},
		{"on error {code: msg}, during msg\nend", "duplicate name", 1, 30},
	} {
		t.Run(tc.source, func(t *testing.T) {
			tree, err := syntax.Parse(tc.source)
			if err != nil {
				t.Fatal(err)
			}
			u := Check(tree, Options{})
			if tc.code == "" {
				if len(u.Diagnostics) != 0 {
					t.Fatal(u.Diagnostics)
				}
				b := u.Bodies[tree.Declarations[0]]
				if b.During == "during" {
					if b.Slot("during") != 2 {
						t.Fatal(b.Locals)
					}
					return
				}
				if b.Slot("msg") != 2 {
					t.Fatal(b.Locals)
				}
				lambda := tree.Declarations[0].Body[0].Children[0]
				if c := u.Bodies[lambda].Captures; len(c) != 1 || c[0].Name != "msg" {
					t.Fatal(c)
				}
				return
			}
			for _, d := range u.Diagnostics {
				if d.Code == tc.code && d.Pos == (syntax.Position{Line: tc.line, Column: tc.col}) {
					return
				}
			}
			t.Fatalf("want %s at %d:%d, got %v", tc.code, tc.line, tc.col, u.Diagnostics)
		})
	}
}
