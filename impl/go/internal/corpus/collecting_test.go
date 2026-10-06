package corpus

import (
	"io"
	"os"
	"strings"
	"testing"
)

func TestCollectingAcceptance(t *testing.T) {
	const root = "../../../../corpus"
	cases, err := Discover(root, []string{"collecting/zero-passes", "collecting/next-filter", "collecting/exit", "collecting/partial-error", "collecting/condition-target", "collecting/waiting-body"})
	if err != nil {
		t.Fatal(err)
	}
	if len(cases) != 6 {
		t.Fatalf("collecting: got %d cases, want 6", len(cases))
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
