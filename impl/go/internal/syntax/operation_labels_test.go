package syntax

import (
	"strings"
	"testing"
)

// An Operation call's arguments are a comma list, or one argument and then
// `label argument` pairs (ADR 0115). The name stays the Operation's, and the
// label tokens stay on the node. `into` and `and wait` still end the
// arguments.
func TestOperationArgumentLabels(t *testing.T) {
	for _, tc := range []struct {
		source, op, labels, target string
		args                       int
		wait                       bool
	}{
		{"ask g to move a to b", "move", "to", "", 2, false},
		{"ask g to move a, b", "move", "", "", 2, false},
		{"ask g to move a to b into c", "move", "to", "c", 2, false},
		{"ask g to slide a across b by 2 and wait", "slide", "across by", "", 3, true},
		{"tell g to place a at b", "place", "at", "", 2, false},
		{"tell g\n    place a at b\n  end tell", "place", "at", "", 2, false},
		{"ask g to move a", "move", "", "", 1, false},
	} {
		tree, err := Parse("on t a, b\n  " + tc.source + "\nend t\n")
		if err != nil {
			t.Fatal(tc.source, err)
		}
		n := tree.Declarations[0].Body[0]
		if n.Kind == "tell-block" {
			n = n.Body[0]
		}
		var labels []string
		for _, label := range n.Labels {
			labels = append(labels, label.Raw)
		}
		target := ""
		if n.Target != nil {
			target = n.Target.Text
		}
		if n.Text != tc.op || strings.Join(labels, " ") != tc.labels || len(n.Children) != tc.args || target != tc.target || HasFlag(n, "and") != tc.wait {
			t.Errorf("%s: %s %v %d %q", tc.source, n.Text, labels, len(n.Children), target)
		}
	}
	tree, err := Parse("on t\n  ask g to move 1 to 2\nend t\n")
	if err != nil {
		t.Fatal(err)
	}
	if label := tree.Declarations[0].Body[0].Labels[0]; label.Pos != (Position{Line: 2, Column: 19}) {
		t.Fatal(label.Pos)
	}
	for _, tc := range []struct {
		source    string
		line, col int
	}{
		// No labels after a comma list, no label before the first argument,
		// and never `from`, `otherwise` or `with`.
		{"  ask g to move a, b to c", 2, 22},
		{"  ask g to move to b", 2, 17},
		{"  ask g to move a from b", 2, 19},
		{"  ask g to move a to b, c", 2, 23},
	} {
		_, err := Parse("on t a, b, c\n" + tc.source + "\nend t\n")
		e, ok := err.(*Error)
		if !ok || e.Code != "unexpected token" || e.Pos != (Position{Line: tc.line, Column: tc.col}) {
			t.Errorf("%s: %v", tc.source, err)
		}
	}
}

func TestIsLabel(t *testing.T) {
	for word, want := range map[string]bool{"to": true, "at": true, "toward": true, "from": false, "with": false, "otherwise": false, "into": false, "and": false, "": false, "a b": false, "1": false, "to:": false} {
		if IsLabel(word) != want {
			t.Errorf("%q: want %v", word, want)
		}
	}
}
