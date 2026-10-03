package corpus

import (
	"io"
	"os"
	"strings"
	"testing"
)

func TestExecutionBackends(t *testing.T) {
	cases, e := Discover("../../../../corpus", nil)
	if e != nil {
		t.Fatal(e)
	}
	count := 0
	r := Runner{Root: "../../../../corpus", Output: io.Discard, Backends: ExecutionBackends()}
	for _, c := range cases {
		if c.Kind == "trace" && (len(c.Name) >= 11 && c.Name[:11] == "text-model/" || len(c.Name) >= 17 && c.Name[:17] == "load-diagnostics/") {
			count++
			t.Run(c.Name, func(t *testing.T) {
				if _, e := r.execute(c); e != nil {
					t.Fatal(e)
				}
			})
		}
	}
	if count != 40 {
		t.Fatalf("expected 40 Trace cases, got %d", count)
	}
}

// The step-1 set is an acceptance gate independent of opportunistic side cases.
// Removing an implemented backend or a required passing-list entry must fail.
func TestPassingListContainsFullStepOneSet(t *testing.T) {
	cases, e := Discover("../../../../corpus", nil)
	if e != nil {
		t.Fatal(e)
	}
	b, e := os.ReadFile("../../corpus-passing.txt")
	if e != nil {
		t.Fatal(e)
	}
	listed := map[string]bool{}
	for _, line := range strings.Split(string(b), "\n") {
		listed[line] = true
	}
	count := 0
	for _, c := range cases {
		required := strings.HasPrefix(c.Name, "text-model/") || strings.HasPrefix(c.Name, "load-diagnostics/") || strings.HasPrefix(c.Name, "disassembly/") || c.Name == "bytes/value-encoding" || c.Name == "dates/value-encoding" || c.Name == "quantities/value-encoding"
		if !required {
			continue
		}
		count++
		if !listed[c.Name] {
			t.Errorf("required step-1 case not listed: %s", c.Name)
		}
	}
	if count != 50 {
		t.Fatalf("required set: %d cases, want 50", count)
	}
}

// Step 2 completes against reviewed TS-produced cases, with execution through
// the public Group API and comparison of every Trace record. The limits cases
// are tracked by #135; pattern-size-literal-limit also requires #136 Reload.
func TestTextPatternStepTwoAcceptance(t *testing.T) {
	const root = "../../../../corpus"
	names := []string{
		"text-patterns/canonical-source-leading-group",
		"text-patterns/empty-match-skipped-after-match",
		"text-patterns/empty-matches-step-one-character",
		"text-patterns/greedy-by-default",
		"text-patterns/lazily-prefers-fewer",
		"text-patterns/lazily-stays-on-its-element",
		"text-patterns/or-is-leftmost-first",
		"text-patterns/replace-all-empty-matches",
	}
	cases, err := Discover(root, names)
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile("../../corpus-passing.txt")
	if err != nil {
		t.Fatal(err)
	}
	listed := map[string]bool{}
	for _, line := range strings.Split(string(b), "\n") {
		listed[line] = true
	}
	r := Runner{Root: root, Output: io.Discard, Backends: ExecutionBackends()}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			if !listed[c.Name] {
				t.Errorf("required step-2 case not listed: %s", c.Name)
			}
			if _, err := r.execute(c); err != nil {
				t.Fatal(err)
			}
		})
	}
}
