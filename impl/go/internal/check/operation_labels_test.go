package check

import (
	"testing"

	"github.com/odogono/odgn-talk/impl/go/internal/shape"
	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
)

var text = shape.Shape{Kind: "kind", Name: "text"}
var labelGrants = map[string]map[string]OperationCheck{"world": {
	"move":  {Mode: "immediate", Args: []shape.Shape{text, text}, Labels: []string{"to"}},
	"slide": {Mode: "fire-and-forget", Args: []shape.Shape{text, text, {Kind: "kind", Name: "number"}}, Labels: []string{"across", "by"}},
	"mark":  {Mode: "fire-and-forget", Args: []shape.Shape{text, {Kind: "optional", Of: []shape.Shape{text}}, {Kind: "optional", Of: []shape.Shape{text}}}, Labels: []string{"at", "by"}},
	"swap":  {Mode: "immediate", Args: []shape.Shape{text, text}},
	"fetch": {Mode: "suspending", Args: []shape.Shape{text, text}, Labels: []string{"toward"}},
}}

// A labelled call writes the declared labels in order, and leaves off those
// of trailing Optional arguments it leaves off (ADR 0115). The argument count
// and the mode are checked first.
func TestOperationLabelDiagnostics(t *testing.T) {
	for _, tc := range []struct {
		line, code string
		row, col   int
	}{
		{`ask world to move "a" to "b"`, "", 0, 0},
		{`ask world to move "a", "b"`, "", 0, 0},
		{`tell world to slide "a" across "b" by 2`, "", 0, 0},
		{`tell world to mark "a"`, "", 0, 0},
		{`tell world to mark "a" at "b"`, "", 0, 0},
		{`tell world to mark "a" at "b" by "c"`, "", 0, 0},
		{`ask world to move "a" at "b"`, "wrong labels", 2, 24},
		{`tell world to slide "a" across "b" to 2`, "wrong labels", 2, 37},
		{`tell world to mark "a" by "b"`, "wrong labels", 2, 25},
		{`ask world to swap "a" to "b"`, "wrong labels", 2, 24},
		{`ask world to move "a" to "b" to "c"`, "wrong argument count", 2, 15},
		{`ask world to move "a" to "b" and wait`, "wrong mode", 2, 2},
		{"tell world\n  slide \"a\" toward \"b\" by 2\n end tell", "wrong labels", 3, 13},
		{"wait for all\n  ask world to fetch \"a\" at \"b\" and wait\n end wait", "wrong labels", 3, 26},
	} {
		tree, err := syntax.Parse("on go\n " + tc.line + "\nend go\n")
		if err != nil {
			t.Fatal(tc.line, err)
		}
		d := Check(tree, Options{Grants: labelGrants}).Diagnostics
		if tc.code == "" {
			if len(d) != 0 {
				t.Errorf("%s: %v", tc.line, d)
			}
			continue
		}
		if len(d) != 1 || d[0].Code != tc.code || d[0].Pos != (syntax.Position{Line: tc.row, Column: tc.col}) {
			t.Errorf("%s: %v", tc.line, d)
		}
	}
}

// A Library's labelled call is checked again at an importer's `use` line
// against the importer's declarations, naming the original call site.
func TestOperationLabelsRecheckedAtImport(t *testing.T) {
	library, err := syntax.Parse("on route a, b\n ask world to move a to b\nend route\n")
	if err != nil {
		t.Fatal(err)
	}
	u := Check(library, Options{Library: true, Grants: labelGrants})
	if len(u.Diagnostics) != 0 {
		t.Fatal(u.Diagnostics)
	}
	calls := map[string][]OperationUse{"router": OperationUses(library, "router")}
	imports := map[string]map[string]Symbol{"router": {"route": {Kind: "handler", Name: "route", Required: 2, Maximum: 2}}}
	toward := map[string]map[string]OperationCheck{"world": {"move": {Mode: "immediate", Args: labelGrants["world"]["move"].Args, Labels: []string{"toward"}}}}
	for _, tc := range []struct {
		grants map[string]map[string]OperationCheck
		code   string
	}{{labelGrants, ""}, {toward, "wrong labels"}} {
		tree, err := syntax.Parse("use route from router\n")
		if err != nil {
			t.Fatal(err)
		}
		d := Check(tree, Options{Grants: tc.grants, Imports: imports, ImportCalls: calls}).Diagnostics
		if tc.code == "" && len(d) != 0 || tc.code != "" && (len(d) != 1 || d[0].Code != tc.code || d[0].Pos != (syntax.Position{Line: 1, Column: 1}) || d[0].Message != "wrong labels: world.move at router:2:2") {
			t.Errorf("%v", d)
		}
	}
}

// A `command` Operation with labels offers a Selector for each spelling
// (ADR 0115): `move a, b` and `move a to b` call it, a Handler with the
// labelled Selector takes only that spelling, and another Selector stays a
// Command Call.
func TestLabelledHostCommands(t *testing.T) {
	two := []shape.Shape{{Kind: "any"}, {Kind: "any"}}
	optional := shape.Shape{Kind: "optional", Of: []shape.Shape{{Kind: "any"}}}
	grants := map[string]map[string]OperationCheck{"world": {
		"move": {Mode: "immediate", Args: two, Labels: []string{"to"}, Command: true},
		"mark": {Mode: "fire-and-forget", Args: []shape.Shape{{Kind: "any"}, optional, optional}, Labels: []string{"at", "by"}, Command: true},
	}}
	if got := grants["world"]["mark"].Selectors("mark"); len(got) != 3 || got[1] != "mark:at:" || got[2] != "mark:at:by:" {
		t.Fatal(got)
	}
	for _, tc := range []struct {
		source string
		want   []string
	}{
		{"on go\n move 1 to 2\n move 1, 2\n move 1 at 2\n mark 1\n mark 1 at 2\n mark 1 at 2 by 3\n mark 1 by 2\nend go", []string{"ask world move [to]", "ask world move []", "command move:at:", "tell world mark []", "tell world mark [at]", "tell world mark [at by]", "command mark:by:"}},
		{"on move a to b\nend move\non go\n move 1 to 2\n move 1, 2\nend go", []string{"command move:to:", "ask world move []"}},
	} {
		tree, err := syntax.Parse(tc.source)
		if err != nil {
			t.Fatal(err)
		}
		if d := Check(tree, Options{Grants: grants}).Diagnostics; len(d) != 0 {
			t.Fatal(d)
		}
		var got []string
		for _, n := range tree.Declarations[len(tree.Declarations)-1].Body {
			call := n.Kind
			if n.Kind == "command" {
				call += " " + n.Text
			} else {
				labels := ""
				for i, label := range n.Labels {
					if i > 0 {
						labels += " "
					}
					labels += label.Raw
				}
				call += " " + n.Params[0].Text + " " + n.Text + " [" + labels + "]"
			}
			got = append(got, call)
		}
		if len(got) != len(tc.want) {
			t.Fatal(got)
		}
		for i := range got {
			if got[i] != tc.want[i] {
				t.Errorf("%q", got)
				break
			}
		}
	}
	// Two Grants offering the labelled Selector clash at the call; one
	// offering only the plain name doesn't.
	twice := map[string]map[string]OperationCheck{"world": grants["world"], "board": {"move": {Mode: "immediate", Args: two, Labels: []string{"to"}, Command: true}}}
	plain := map[string]map[string]OperationCheck{"world": grants["world"], "board": {"move": {Mode: "immediate", Args: two, Command: true}}}
	for _, tc := range []struct {
		grants map[string]map[string]OperationCheck
		source string
		clash  bool
	}{
		{twice, "on go\n move 1 to 2\nend go", true},
		{plain, "on go\n move 1 to 2\nend go", false},
		{plain, "on go\n move 1, 2\nend go", true},
	} {
		tree, err := syntax.Parse(tc.source)
		if err != nil {
			t.Fatal(err)
		}
		d := Check(tree, Options{Grants: tc.grants}).Diagnostics
		if tc.clash != (len(d) == 1 && d[0].Code == "name clash" && d[0].Pos == syntax.Position{Line: 2, Column: 2}) || !tc.clash && len(d) != 0 {
			t.Errorf("%s: %v", tc.source, d)
		}
	}
}
