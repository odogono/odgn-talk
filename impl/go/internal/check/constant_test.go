package check

import (
	"testing"

	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
)

func TestConstantFirstDisallowedToken(t *testing.T) {
	for _, tc := range []struct {
		name, source string
		want         []Diagnostic
	}{
		{
			"repeated variable",
			"script variable v = 1\nconstant x = v + v",
			[]Diagnostic{{Code: "not constant", Pos: syntax.Position{Line: 2, Column: 14}}},
		},
		{
			"later unknown name",
			"script variable v = 1\nconstant x = v otherwise unknown",
			[]Diagnostic{
				{Code: "not constant", Pos: syntax.Position{Line: 2, Column: 14}},
				{Code: "unknown name", Pos: syntax.Position{Line: 2, Column: 26}},
			},
		},
		{
			"script variable initialiser",
			"script variable v = 1\nscript variable x = v + v",
			[]Diagnostic{{Code: "not constant", Pos: syntax.Position{Line: 2, Column: 21}}},
		},
		{
			"separate parameter defaults",
			"script variable v = 1\nfunction f a = v + v, b = v + v\nreturn a + b\nend",
			[]Diagnostic{
				{Code: "not constant", Pos: syntax.Position{Line: 2, Column: 16}},
				{Code: "not constant", Pos: syntax.Position{Line: 2, Column: 27}},
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := diagnosticsOf(t, tc.source, Options{})
			if len(got) != len(tc.want) {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
			for i, want := range tc.want {
				if got[i].Code != want.Code || got[i].Pos != want.Pos {
					t.Errorf("diagnostic %d: got %v, want %v", i, got[i], want)
				}
			}
		})
	}
}
