package check

import (
	"slices"
	"testing"

	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
)

func TestItOutsideBody(t *testing.T) {
	for _, tc := range []struct {
		name, source string
		want         []Diagnostic
	}{
		{
			"constant", "constant x = it",
			[]Diagnostic{
				{Code: "unknown name", Pos: syntax.Position{Line: 1, Column: 14}},
				{Code: "not constant", Pos: syntax.Position{Line: 1, Column: 14}},
			},
		},
		{
			"script variable", "script variable x = it",
			[]Diagnostic{
				{Code: "unknown name", Pos: syntax.Position{Line: 1, Column: 21}},
				{Code: "not constant", Pos: syntax.Position{Line: 1, Column: 21}},
			},
		},
		{
			"parameter default", "function f x = it\nreturn it\nend",
			[]Diagnostic{
				{Code: "unknown name", Pos: syntax.Position{Line: 1, Column: 16}},
				{Code: "not constant", Pos: syntax.Position{Line: 1, Column: 16}},
			},
		},
		{
			"later constant operands", "script variable v = 1\nconstant x = [v, it, it]",
			[]Diagnostic{
				{Code: "not constant", Pos: syntax.Position{Line: 2, Column: 15}},
				{Code: "unknown name", Pos: syntax.Position{Line: 2, Column: 18}},
				{Code: "unknown name", Pos: syntax.Position{Line: 2, Column: 22}},
			},
		},
		{
			"later script variable operand", "script variable v = 1\nscript variable x = v otherwise it",
			[]Diagnostic{
				{Code: "not constant", Pos: syntax.Position{Line: 2, Column: 21}},
				{Code: "unknown name", Pos: syntax.Position{Line: 2, Column: 33}},
			},
		},
		{
			"later parameter default operand", "script variable v = 1\nfunction f x = v + it\nreturn it\nend",
			[]Diagnostic{
				{Code: "not constant", Pos: syntax.Position{Line: 2, Column: 16}},
				{Code: "unknown name", Pos: syntax.Position{Line: 2, Column: 20}},
			},
		},
		{
			"repeated it", "constant x = it otherwise it",
			[]Diagnostic{
				{Code: "unknown name", Pos: syntax.Position{Line: 1, Column: 14}},
				{Code: "not constant", Pos: syntax.Position{Line: 1, Column: 14}},
				{Code: "unknown name", Pos: syntax.Position{Line: 1, Column: 27}},
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := diagnosticsOf(t, tc.source, Options{}); !slices.Equal(got, tc.want) {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}
}

func TestItBodyLocal(t *testing.T) {
	for _, source := range []string{
		"on t where it is nothing\nreturn it\nend",
		"function f\nreturn it\nend",
		"on t\nreturn given: given: it\nend",
		"constant f = given: it",
		"script variable f = given\nreturn it\nend",
		"function f x = given: it\nreturn it\nend",
	} {
		for _, library := range []bool{false, true} {
			if library && source == "script variable f = given\nreturn it\nend" {
				continue // Libraries cannot have Script Variables.
			}
			if got := diagnosticsOf(t, source, Options{Library: library}); len(got) != 0 {
				t.Errorf("%q (library=%t): got %v, want no diagnostics", source, library, got)
			}
		}
	}
}
