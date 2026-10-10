package syntax

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
)

func TestCompactParsePreservesDeclarationsAndDocumentation(t *testing.T) {
	data, err := os.ReadFile("../../../testdata/declaration-docs.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Units []struct{ Name, Source string }
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Units) == 0 {
		t.Fatal("no documentation fixtures")
	}
	for _, tc := range fixture.Units {
		t.Run(tc.Name, func(t *testing.T) {
			full, fullErr := Parse(tc.Source)
			compact, compactErr := ParseCompact(tc.Source)
			if !reflect.DeepEqual(fullErr, compactErr) {
				t.Fatalf("%v / %v", fullErr, compactErr)
			}
			if fullErr != nil {
				return
			}
			if compact.Source() != tc.Source || len(compact.Tokens) != 0 || !reflect.DeepEqual(full.Declarations, compact.Declarations) {
				t.Fatal("compact parse changed source or syntax, or retained the token tape")
			}
			for i, decl := range compact.Declarations {
				if got, want := compact.Documentation(decl), full.Documentation(full.Declarations[i]); got != want {
					t.Fatalf("documentation %q; want %q", got, want)
				}
			}
		})
	}
}

func TestParsedFirstPositionsAreCachedAndPreserveOperatorPositions(t *testing.T) {
	tree, err := ParseCompact("on sum where 1" + strings.Repeat(" + 1", MaxNesting-4) + "\nreturn 1\nend sum\n")
	if err != nil {
		t.Fatal(err)
	}
	guard := tree.Declarations[0].Guard
	if guard.FirstPos() != (Position{1, 14}) || guard.Pos() == guard.FirstPos() {
		t.Fatal("Guard and operator positions were conflated")
	}
	Walk(tree.Declarations[0], func(n *Node) bool {
		if n.first.Line == 0 {
			t.Fatal("uncached source position")
		}
		return true
	})
}
