package session

import (
	"strings"
	"testing"
	"time"

	talk "github.com/odogono/odgn-talk/impl/go"
)

func TestFunctionMetadataAcrossSessionExposuresAndRestore(t *testing.T) {
	h := New(Environment{Now: func() time.Time { return time.Unix(0, 0) }})
	for _, source := range []string{
		"function double n, m = 1\n return n * 2\nend double",
		"put double into f",
		"put given [x, y], z: x + y + z into pair",
		"put given: 1 into zero",
		"put {functions: [f, pair, zero]} into nested",
	} {
		if out := h.Input(source); len(out) != 0 {
			t.Fatal(source, out)
		}
	}
	check := func() {
		t.Helper()
		for _, test := range []struct{ expression, metadata string }{
			{"f", `function {name: "double", arity: 1..2, home: "session"}`},
			{"pair", `function {name: nothing, arity: 2..2, home: "session"}`},
			{"zero", `function {name: nothing, arity: 0..0, home: "session"}`},
			{"item 1 of the functions of nested", `function {name: "double", arity: 1..2, home: "session"}`},
		} {
			// :inspect observes a Run result; :describe observes Inspect's vars.
			commands := []string{":inspect " + test.expression}
			if test.expression == "f" {
				commands = append(commands, ":describe f")
			}
			for _, command := range commands {
				if out := h.Input(command); !strings.Contains(strings.Join(out, "\n"), test.metadata) {
					t.Fatalf("%s: got %v, missing %s", command, out, test.metadata)
				}
			}
		}
	}
	check()
	if out := h.Input("function double n\n return n + n\nend double"); len(out) != 0 {
		t.Fatal(out)
	}
	check() // The held function keeps its old optional parameter when stale.
	for round := 0; round < 2; round++ {
		for _, command := range []string{":save s", ":restore s"} {
			if out := h.Input(command); len(out) != 1 || strings.HasPrefix(out[0], "!") {
				t.Fatal(command, out)
			}
		}
		check()
	}
}

func TestFunctionDocumentationRetainsDefiningVersionsAcrossRestore(t *testing.T) {
	h := New(Environment{Now: func() time.Time { return time.Unix(0, 0) }})
	input := func(source string) {
		t.Helper()
		if out := h.Input(source); len(out) != 0 {
			t.Fatal(source, out)
		}
	}
	value := func(name string) talk.Value {
		t.Helper()
		for _, pair := range h.Inspect().Scripts[0].Vars {
			if pair.Key == name {
				return pair.Val
			}
		}
		t.Fatal("missing variable", name)
		return talk.Nothing
	}
	// Keep the exact source scalars as documentation; the defining unit,
	// rather than a current same-name declaration, determines this text.
	const original = "Original e\u0301."
	input("--| " + original + "\nfunction double n\n return n * 2\nend double")
	input("put double into old")
	old := value("old")
	if out := h.Input(":save before"); len(out) != 1 || out[0] != "saved before" {
		t.Fatal(out)
	}
	input("--| Replacement.\nfunction double n\n return n * 2\nend double")
	input("put double into newer")
	newer := value("newer")
	for round := 0; round < 2; round++ {
		for _, test := range []struct {
			value talk.Value
			doc   string
		}{{old, original}, {newer, "Replacement."}} {
			if doc, ok := h.FunctionDocumentation(test.value); !ok || doc != test.doc {
				t.Fatalf("round %d: documentation %q, want %q", round, doc, test.doc)
			}
		}
		if out := h.Input(":restore before"); len(out) != 1 || out[0] != "restored before" {
			t.Fatal(out)
		}
		old = value("old")
	}
}
