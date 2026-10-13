package check

import (
	"testing"

	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
)

func diagnosticsOf(t *testing.T, source string, options Options) []Diagnostic {
	t.Helper()
	tree, err := syntax.Parse(source)
	if err != nil {
		t.Fatalf("%q: %v", source, err)
	}
	return Check(tree, options).Diagnostics
}

func hasCode(diags []Diagnostic, code string) bool {
	for _, d := range diags {
		if d.Code == code {
			return true
		}
	}
	return false
}

// Design groups 7 and 8 (#720): both forms are checked in every operand,
// including an unselected fallback, and stay eligible in Constants,
// initializers and parameter defaults when their operands are.
func TestNothingDefaultsChecking(t *testing.T) {
	// A forbidden call in an unselected Guard branch still fails checking.
	guard := "function f x\nreturn x\nend\non t x where true otherwise f(x)\nend"
	if diags := diagnosticsOf(t, guard, Options{}); !hasCode(diags, "not in a guard") {
		t.Errorf("guard fallback call: got %v, want not in a guard", diags)
	}
	guard = "function f x\nreturn x\nend\non t x where f(x) otherwise true\nend"
	if diags := diagnosticsOf(t, guard, Options{}); !hasCode(diags, "not in a guard") {
		t.Errorf("guard left call: got %v, want not in a guard", diags)
	}
	// An optional read of a statically known Host Object is not a Guard
	// load error: it fails at runtime and skips the clause. The ordinary
	// `id` read of the same object stays allowed.
	for _, expression := range []string{"the optional id of warehouse", "the id of warehouse"} {
		source := "on t where " + expression + " is \"w1\"\nend"
		if diags := diagnosticsOf(t, source, Options{Objects: []string{"warehouse"}}); len(diags) != 0 {
			t.Errorf("%s: got %v, want no diagnostics", expression, diags)
		}
	}
	// Unknown names are reported in either branch.
	for _, source := range []string{
		"on t\nreturn absent otherwise 1\nend",
		"on t\nreturn 1 otherwise absent\nend",
		"on t\nreturn the optional k of absent\nend",
		"on t\nreturn the optional (absent) of nothing\nend",
	} {
		if diags := diagnosticsOf(t, source, Options{}); !hasCode(diags, "unknown name") {
			t.Errorf("%q: got %v, want unknown name", source, diags)
		}
	}
	// Constants, Script Variable initializers and parameter defaults.
	for _, source := range []string{
		"constant fallback = 3\nconstant x = nothing otherwise fallback",
		"constant m = {a: 1}\nconstant x = the optional a of m otherwise 0",
		"script variable x = the optional a of nothing otherwise 1",
		"function f a = nothing otherwise 1\nreturn a\nend",
		"on t xs\nreturn every item of xs whose the optional active of it otherwise false\nend",
	} {
		if diags := diagnosticsOf(t, source, Options{}); len(diags) != 0 {
			t.Errorf("%q: got %v, want no diagnostics", source, diags)
		}
	}
	for _, source := range []string{
		"script variable v = 1\nconstant x = nothing otherwise v",
		"script variable v = 1\nconstant x = the optional a of v",
		"function f x\nreturn x\nend\nconstant x = nothing otherwise f(1)",
	} {
		if diags := diagnosticsOf(t, source, Options{}); !hasCode(diags, "not constant") {
			t.Errorf("%q: got %v, want not constant", source, diags)
		}
	}
}

// Design group 9: `otherwise` can no longer be an Argument Label, so a
// declaration or command using it as one parses it as the operator.
func TestOtherwiseLabelCompatibility(t *testing.T) {
	// A Handler declared with an `otherwise` label is rejected at the word.
	if _, err := syntax.Parse("on move x otherwise y\nend move\n"); err == nil {
		t.Fatal("declaration with an otherwise label accepted")
	}
	// A command written with the old label now sends the shorter Selector
	// with a defaulted first argument: the documented Selector change.
	tree, err := syntax.Parse("on t\n move 1 otherwise 2\nend t\n")
	if err != nil {
		t.Fatal(err)
	}
	if stmt := tree.Declarations[0].Body[0]; stmt.Text != "move" || len(stmt.Children) != 1 {
		t.Fatalf("command Selector=%q args=%d, want move with one argument", stmt.Text, len(stmt.Children))
	}
	// An ungrouped chunk index named `otherwise` no longer parses.
	if _, err := syntax.Parse("on t\n return item otherwise of xs\nend t\n"); err == nil {
		t.Fatal("ungrouped otherwise chunk index accepted")
	}
	// A Name, function and Handler called `otherwise` remain legal.
	for _, source := range []string{
		"on t\nput 1 into otherwise\nreturn otherwise\nend",
		"function otherwise x\nreturn x\nend\non t\nreturn otherwise(2)\nend",
		"on t\nreturn {otherwise: 1}\nend",
	} {
		if diags := diagnosticsOf(t, source, Options{}); len(diags) != 0 {
			t.Errorf("%q: got %v, want no diagnostics", source, diags)
		}
	}
}
