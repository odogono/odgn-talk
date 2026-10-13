package lower

import (
	"bytes"
	"strings"
	"testing"

	"github.com/odogono/odgn-talk/impl/go/internal/check"
	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
)

// Design group 10 (#720) at the Go level: the normative lowering emits
// all three instructions, positioned at `otherwise` and `the`. Corpus
// Disassembly coverage lands with the coordinated cases (#722).
func TestNothingDefaultsLowering(t *testing.T) {
	tree, err := syntax.Parse("on go m, k\n" +
		" return the optional city of m otherwise the optional (k) of m otherwise \"unknown\"\n" +
		"end go\n")
	if err != nil {
		t.Fatal(err)
	}
	unit, err := Compile(check.Check(tree, check.Options{}), "s")
	if err != nil {
		t.Fatal(err)
	}
	dis := unit.Disassemble()
	var code []string
	for _, line := range strings.Split(dis, "\n") {
		line = strings.TrimSpace(line)
		if len(line) > 4 && line[0] >= '0' && line[0] <= '9' {
			code = append(code, line)
		}
	}
	// The handler body is the second body's code: find the return's first
	// instruction by its position at `the` (2:9).
	start := -1
	for i, line := range code {
		if strings.Contains(line, "2:9 get-optional-key \"city\"") {
			start = i - 1 // the load of m before it
		}
	}
	if start < 0 {
		t.Fatalf("no get-optional-key at 2:9 in\n%s", dis)
	}
	type want struct{ pos, op string }
	wants := []want{
		{"2:30", "load"},                      // m, at its own token after `of`
		{"2:9", "get-optional-key"},           // at `the`
		{"2:32", "branch-not-nothing"},        // at the first `otherwise`
		{"2:32", "pop"},                       // at the first `otherwise`
		{"2:56", "load"},                      // k inside its parentheses
		{"2:62", "load"},                      // m
		{"2:42", "get-optional-key-computed"}, // at the second `the`
		{"2:64", "branch-not-nothing"},        // at the second `otherwise`
		{"2:64", "pop"},
		{"2:74", "const"}, // "unknown"
	}
	got := code[start:]
	if len(got) < len(wants) {
		t.Fatalf("only %d instructions from the return:\n%s", len(got), dis)
	}
	for i, w := range wants {
		fields := strings.Fields(got[i])
		if len(fields) < 3 || fields[1] != w.pos || fields[2] != w.op {
			t.Errorf("instruction %d: got %q, want %s at %s", i, got[i], w.op, w.pos)
		}
	}
	// Each branch-not-nothing jumps past its own fallback only: the first
	// lands on the second branch-not-nothing, so a chain keeps every
	// branch charge (no jump past later defaults).
	branchTarget := func(line string) string {
		fields := strings.Fields(line)
		return fields[len(fields)-1]
	}
	first := code[start+2]
	second := code[start+7]
	if !strings.HasPrefix(second, branchTarget(first)+" ") {
		t.Errorf("first branch %q does not land on the second branch %q", first, second)
	}
	// The three instructions round-trip through Bytecode unchanged.
	for _, body := range unit.Bodies {
		decoded, err := decodeBytecode(body.Bytecode())
		if err != nil {
			t.Fatal(err)
		}
		if roundTrip := (&Body{Code: decoded}).Bytecode(); !bytes.Equal(body.Bytecode(), roundTrip) {
			t.Fatalf("bytecode changed after decoding body %d", body.Index)
		}
	}
}
