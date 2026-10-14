package check

import (
	"testing"

	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
)

func TestHandlerRejectsNeedlessAndWait(t *testing.T) {
	for _, tc := range []struct{ name, source, diagnostic string }{
		{"empty Handler", "on h\nend h\non go\n h and wait\nend go", "needless and wait at 4:2"},
		{"later declaration", "on go\n h and wait\nend go\non h\n return 1\nend h", "needless and wait at 2:2"},
		{"shared Script Variable", "script variable h = 1\non h\n return h\nend h\non go\n h and wait\nend go", "needless and wait at 6:2"},
		{"shared Constant", "on h\n return h\nend h\nconstant h = 1\non go\n h and wait\nend go", "needless and wait at 6:2"},
		{"multiple pure clauses", "on h 0\n return 0\nend h\non h n\n return n\nend h\non go\n h 1 and wait\nend go", "needless and wait at 8:2"},
		{"transitively pure", "on h\n helper\nend h\non helper\n return 1\nend helper\non go\n h and wait\nend go", "needless and wait at 8:2"},
		{"block Lambda", "on h\nend h\non go\n put given\n  h and wait\n end into f\nend go", "needless and wait at 5:3"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tree, err := syntax.Parse(tc.source)
			if err != nil {
				t.Fatal(err)
			}
			got := Check(tree, Options{}).Diagnostics
			if len(got) != 1 || got[0].String() != tc.diagnostic {
				t.Fatalf("got %v, want %s", got, tc.diagnostic)
			}
		})
	}
}

func TestHandlerAllowsAndWait(t *testing.T) {
	for _, tc := range []struct{ name, source string }{
		{"direct suspension", "on h\n wait 1 s\nend h\non go\n h and wait\nend go"},
		{"transitive suspension", "on h\n helper and wait\nend h\non helper\n wait 1 s\nend helper\non go\n h and wait\nend go"},
		{"earlier suspending clause", "on h 0\n wait 1 s\nend h\non h n\n return n\nend h\non go\n h 1 and wait\nend go"},
		{"later suspending clause", "on h 0\n return 0\nend h\non h n\n wait 1 s\nend h\non go\n h 0 and wait\nend go"},
		{"shared Script Variable", "script variable h = 1\non h\n wait 1 s\nend h\non go\n h and wait\nend go"},
		{"shared Constant", "constant h = 1\non h\n wait 1 s\nend h\non go\n h and wait\nend go"},
		{"unresolved Message Path call", "on go\n inherited and wait\nend go"},
		{"send to pure local Handler", "on h\n return 1\nend h\non go\n send h to me and wait\nend go"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tree, err := syntax.Parse(tc.source)
			if err != nil {
				t.Fatal(err)
			}
			if got := Check(tree, Options{}).Diagnostics; len(got) != 0 {
				t.Fatal(got)
			}
		})
	}
}
