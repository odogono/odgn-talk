package check

import (
	"testing"

	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
)

func TestResultTargetDiagnostics(t *testing.T) {
	for _, tc := range []struct {
		name, source, code string
		pos                syntax.Position
	}{
		{"captured local", "on t\n put 1 into locked\n put given\n  ask g to op into locked\n end given into f\nend t\n", "can't write", syntax.Position{Line: 4, Column: 20}},
		{"constant", "constant k = 1\non t\n ask g to op into k\nend t\n", "can't write", syntax.Position{Line: 3, Column: 19}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tree, err := syntax.Parse(tc.source)
			if err != nil {
				t.Fatal(err)
			}
			diagnostics := Check(tree, Options{}).Diagnostics
			found := false
			for _, d := range diagnostics {
				found = found || d.Code == tc.code && d.Pos == tc.pos
			}
			if !found {
				t.Fatal(diagnostics)
			}
		})
	}
	tree, err := syntax.Parse("on t\n wait for all\n  ask g to op into y\n  ask g to op and wait\n end wait\n return y\nend t\n")
	if err != nil {
		t.Fatal(err)
	}
	if d := Check(tree, Options{}).Diagnostics; len(d) != 0 {
		t.Fatal("immediate ask in a Join:", d)
	}
}
