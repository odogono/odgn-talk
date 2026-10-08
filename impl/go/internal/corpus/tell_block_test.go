package corpus

import (
	"io"
	"os"
	"strings"
	"testing"
)

// The `tell` block cases (ADR 0063) run, and the passing gate requires them.
func TestTellBlockAcceptance(t *testing.T) {
	const root = "../../../../corpus"
	cases, err := Discover(root, []string{"tell-block/equivalent", "tell-block/join", "tell-block/load-checks", "tell-block/library", "disassembly/tell-block"})
	if err != nil {
		t.Fatal(err)
	}
	if len(cases) != 5 {
		t.Fatalf("tell blocks: got %d cases, want 5", len(cases))
	}
	gate, err := os.ReadFile("../../corpus-passing.txt")
	if err != nil {
		t.Fatal(err)
	}
	r := Runner{Root: root, Output: io.Discard, Backends: ExecutionBackends()}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			if !strings.Contains("\n"+string(gate), "\n"+c.Name+"\n") {
				t.Fatal("missing passing gate", c.Name)
			}
			if _, err := r.execute(c); err != nil {
				t.Fatal(err)
			}
		})
	}
}
