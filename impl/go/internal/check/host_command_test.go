package check

import (
	"testing"

	"github.com/odogono/odgn-talk/impl/go/internal/shape"
	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
)

var anyArg = []shape.Shape{{Kind: "any"}}
var hostCommandGrants = map[string]map[string]OperationCheck{"till": {
	"price": {Mode: "immediate", Args: anyArg, Command: true},
	"note":  {Mode: "fire-and-forget", Args: anyArg, Command: true},
	"fetch": {Mode: "suspending", Args: anyArg, Command: true},
	"plain": {Mode: "immediate"},
}}

// A Command Call naming no Handler becomes the one-line call its Host
// Command stands for (ADR 0094); a Handler, a labelled call, `say` and an
// Operation not declared `command` stay Command Calls.
func TestHostCommandsResolveToTheirCalls(t *testing.T) {
	tree, err := syntax.Parse("on go\n price 1\n note 1\n note 1 and wait\n fetch 1 and wait\n note 1 to 2\n plain\n mine\nend go\non mine\nend mine")
	if err != nil {
		t.Fatal(err)
	}
	u := Check(tree, Options{Grants: hostCommandGrants})
	if len(u.Diagnostics) != 1 || u.Diagnostics[0].Code != "wrong mode" || u.Diagnostics[0].Pos != (syntax.Position{Line: 4, Column: 2}) {
		t.Fatal(u.Diagnostics)
	}
	var got []string
	for _, n := range tree.Declarations[0].Body {
		call := n.Kind
		if len(n.Params) > 0 {
			call += " " + n.Params[0].Text
		}
		got = append(got, call+" "+n.Text)
	}
	want := []string{"ask till price", "tell till note", "ask till note", "ask till fetch", "command note:to:", "command plain", "command mine"}
	if len(got) != len(want) {
		t.Fatal(got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("%v", got)
		}
	}
}

func TestHostCommandLoadDiagnostics(t *testing.T) {
	twice := map[string]map[string]OperationCheck{"till": hostCommandGrants["till"], "spare": {"price": {Mode: "immediate", Args: anyArg, Command: true}}}
	imports := map[string]map[string]Symbol{"prices": {"price": {Kind: "handler", Name: "price"}}}
	for _, tc := range []struct {
		source  string
		options Options
		code    string
		line    int
		col     int
	}{
		// Two Grants offering the command clash at the call, not at load.
		{"on go\n price 1\nend go", Options{Grants: twice}, "name clash", 2, 2},
		{"on go\n note 1\nend go", Options{Grants: twice}, "", 0, 0},
		// An Import named like a Host Command clashes in the `use` line.
		{"use price from prices", Options{Grants: hostCommandGrants, Imports: imports}, "name clash", 1, 5},
		// `and wait` stays a Command Call's wait inside Joins and Timeout Blocks.
		{"on go\n wait for all\n  fetch 1 and wait\n  ask till to fetch 1 and wait\n end wait\nend go", Options{Grants: hostCommandGrants}, "not in a join", 3, 3},
		{"on go\n with timeout of 5 s\n  fetch 1 and wait\n  wait 1 s\n end timeout\nend go", Options{Grants: hostCommandGrants}, "not in a timeout", 3, 3},
		// A Library's Host Commands resolve before `not in a library`.
		{"on go\n price 1\n note it\nend go", Options{Library: true, Grants: hostCommandGrants}, "", 0, 0},
		{"on go\n plain\nend go", Options{Library: true, Grants: hostCommandGrants}, "not in a library", 2, 2},
		{"function f\n fetch 1 and wait\nend f", Options{Grants: hostCommandGrants}, "can't suspend here", 2, 2},
	} {
		tree, err := syntax.Parse(tc.source)
		if err != nil {
			t.Fatal(err)
		}
		u := Check(tree, tc.options)
		if tc.code == "" {
			if len(u.Diagnostics) != 0 {
				t.Errorf("%q: %v", tc.source, u.Diagnostics)
			}
			continue
		}
		if len(u.Diagnostics) != 1 || u.Diagnostics[0].Code != tc.code || u.Diagnostics[0].Pos != (syntax.Position{Line: tc.line, Column: tc.col}) {
			t.Errorf("%q: %v", tc.source, u.Diagnostics)
		}
	}
}
