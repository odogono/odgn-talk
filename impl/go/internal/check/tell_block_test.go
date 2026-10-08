package check

import (
	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
	"testing"
)

// A `tell` block's lines are checked as the one-line calls they stand for
// (ADR 0063), so suspension rules apply to a waiting line at its Operation
// name.
func TestTellBlockLines(t *testing.T) {
	for _, tc := range []struct {
		source, code string
		line, col    int
	}{
		{"function f\n tell feed\n  fetch 1 and wait\n end tell\nend f", "can't suspend here", 3, 3},
		{"on fetchIt\n tell feed\n  fetch 1 and wait\n end tell\nend fetchIt\non go\n fetchIt\nend go", "missing and wait", 7, 2},
		{"on t\n wait for all\n  try\n   tell feed\n    fetch 1 and wait\n   end tell\n  catch e\n  end try\n end wait\nend t", "not in a join", 5, 5},
		{"on t\n wait for all\n  tell feed\n   fetch 1 and wait\n  end tell\n end wait\nend t", "", 0, 0},
		{"on t\n tell feed\n end tell\nend t", "", 0, 0},
	} {
		tree, err := syntax.Parse(tc.source)
		if err != nil {
			t.Fatal(err)
		}
		u := Check(tree, Options{})
		if tc.code == "" {
			if len(u.Diagnostics) != 0 {
				t.Errorf("%s: %v", tc.source, u.Diagnostics)
			}
			continue
		}
		if len(u.Diagnostics) != 1 || u.Diagnostics[0].Code != tc.code || u.Diagnostics[0].Pos != (syntax.Position{Line: tc.line, Column: tc.col}) {
			t.Errorf("%s: %v", tc.source, u.Diagnostics)
		}
	}
}

// Each line takes its call from its Operation's mode, decided once against
// the unit's Grants, and a Grant the unit doesn't hold is reported once.
func TestTellBlockLineModes(t *testing.T) {
	tree, err := syntax.Parse("on t\n tell till\n  price\n  note\n  fetch and wait\n end tell\n tell drawer\n  open\n  close\n end tell\nend t")
	if err != nil {
		t.Fatal(err)
	}
	grants := map[string]map[string]OperationCheck{"till": {"price": {Mode: "immediate"}, "note": {Mode: "fire-and-forget"}, "fetch": {Mode: "suspending"}}}
	u := Check(tree, Options{Grants: grants})
	if len(u.Diagnostics) != 1 || u.Diagnostics[0].Code != "unknown operation" || u.Diagnostics[0].Pos != (syntax.Position{Line: 7, Column: 7}) {
		t.Fatal(u.Diagnostics)
	}
	var kinds []string
	for _, line := range tree.Declarations[0].Body[0].Body {
		kinds = append(kinds, line.Kind)
	}
	if len(kinds) != 3 || kinds[0] != "ask" || kinds[1] != "tell" || kinds[2] != "ask" {
		t.Fatal(kinds)
	}
}
