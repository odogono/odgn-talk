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

// These new TS-blessed cases are awaiting the human review required by #132.
// The worker Trace replay joins #249; here the checker pins every diag record.
func TestLoadDiagnosticCorpus(t *testing.T) {
	files, err := filepath.Glob("../../../../corpus/load-diagnostics/*/case.trace")
	if err != nil {
		t.Fatal(err)
	}
	record := regexp.MustCompile(`(?m)^diag bad code="([^"]+)" pos=(\d+):(\d+)$`)
	for _, file := range files {
		if strings.Contains(file, "initialiser-failed/") {
			continue
		} // Executed in lower's initializer boundary test.
		t.Run(filepath.Base(filepath.Dir(file)), func(t *testing.T) {
			source, err := os.ReadFile(filepath.Join(filepath.Dir(file), "bad.talk"))
			if err != nil {
				t.Fatal(err)
			}
			tree, err := syntax.Parse(string(source))
			if err != nil {
				t.Fatal(err)
			}
			checked := Check(tree, Options{})
			trace, err := os.ReadFile(file)
			if err != nil {
				t.Fatal(err)
			}
			var expected []Diagnostic
			for _, match := range record.FindAllStringSubmatch(string(trace), -1) {
				line, _ := strconv.Atoi(match[2])
				column, _ := strconv.Atoi(match[3])
				expected = append(expected, Diagnostic{match[1], syntax.Position{Line: line, Column: column}})
			}
			if len(expected) == 0 {
				t.Fatal("case has no diagnostic records")
			}
			if !slices.Equal(checked.Diagnostics, expected) {
				t.Fatalf("expected %v, got %v", expected, checked.Diagnostics)
			}
		})
	}
}
