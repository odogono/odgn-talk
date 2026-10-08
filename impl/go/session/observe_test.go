package session

import (
	"reflect"
	"testing"
)

func TestFuelEntryContinuesLikeAnEntry(t *testing.T) {
	h := New(Environment{})
	for source, more := range map[string]bool{":fuel repeat 2 times": true, ":fuel repeat 2 times\nsay 1\nend repeat": false, ":fuel 1 + 2": false, ":fuel": false, ":runs": false, ":trace greet": false} {
		if got := h.NeedsMore(source); got != more {
			t.Errorf("NeedsMore(%q) = %v", source, got)
		}
	}
}

// A measured Entry that yields to `read` prints its pending row, then its
// final row at the Host call where its family settles.
func TestFuelRowsAtYieldAndSettlement(t *testing.T) {
	h := New(Environment{})
	h.Input(":clock virtual 2026-09-30T10:00:00Z")
	out := h.Input(":fuel ask console to read and wait")
	if !reflect.DeepEqual(out, []string{`fuel {entry: "entry1", fuel: 14, state: "pending", interrupted: false, runs: 1, queued: 0}`}) {
		t.Fatal(out)
	}
	if h.Waiting().Kind != "read" {
		t.Fatal(h.Waiting())
	}
	out = h.Read("hi")
	if !reflect.DeepEqual(out, []string{`fuel {entry: "entry1", fuel: 19, state: "complete", interrupted: false, runs: 0, queued: 0}`}) {
		t.Fatal(out)
	}
	if out := h.Tick(); len(out) != 0 {
		t.Fatal("a settled measurement printed again", out)
	}
}
