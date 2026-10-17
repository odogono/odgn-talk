package session

import (
	"strings"
	"testing"
	"time"
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
