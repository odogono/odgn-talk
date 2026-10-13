package syntax

import (
	"strings"
	"testing"
)

// `otherwise` is the lowest binary operator and optional key reads keep
// their literal keys (#720, design groups 3 and 4).
func TestNothingDefaultsShape(t *testing.T) {
	var shape func(*Node) string
	shape = func(n *Node) string {
		parts := []string{n.Kind + ":" + n.Text}
		for _, child := range n.Children {
			parts = append(parts, shape(child))
		}
		return "(" + strings.Join(parts, " ") + ")"
	}
	for _, tc := range []struct{ expression, want string }{
		{"a otherwise b otherwise c", "(binary:otherwise (binary:otherwise (name:a) (name:b)) (name:c))"},
		{"a + b otherwise 0", "(binary:otherwise (binary:+ (name:a) (name:b)) (literal:0))"},
		{"a otherwise b or c", "(binary:otherwise (name:a) (binary:or (name:b) (name:c)))"},
		{"a or b otherwise c", "(binary:otherwise (binary:or (name:a) (name:b)) (name:c))"},
		{"the optional city of customer", "(optional-key:city (name:customer))"},
		{"the optional length of m", "(optional-key:length (name:m))"},
		{"the optional code points of m", "(optional-key:code points (name:m))"},
		{"the optional optional of m", "(optional-key:optional (name:m))"},
		{`the optional "of" of m`, "(optional-key:of (name:m))"},
		{"the optional (k) of m", "(optional-key-computed:the (name:k) (name:m))"},
		{"the optional of m", "(key:optional (name:m))"},
		{"the optional b of the optional a of m", "(optional-key:b (optional-key:a (name:m)))"},
		{"otherwise", "(name:otherwise)"},
		{"item (otherwise) of xs", "(chunk:item (paren:( (name:otherwise)) (name:xs))"},
		{"the first item of xs whose active otherwise false", "(whose:item (chunk:item (ordinal:first) (name:xs)) (binary:otherwise (key:active (literal:it)) (literal:false)))"},
		{"(the first item of xs whose active) otherwise fallback", "(binary:otherwise (paren:( (whose:item (chunk:item (ordinal:first) (name:xs)) (key:active (literal:it)))) (name:fallback))"},
		{"replace a in s with b otherwise c", "(binary:otherwise (replace-expression:replace (name:a) (name:s) (name:b)) (name:c))"},
		{"[a otherwise 1, b]", "(list:[ (binary:otherwise (name:a) (literal:1)) (name:b))"},
		{"f(a otherwise 1)", "(call:f (binary:otherwise (name:a) (literal:1)))"},
	} {
		tree, err := Parse("on t\n return " + tc.expression + "\nend t")
		if err != nil {
			t.Fatalf("%s: %v", tc.expression, err)
		}
		n := tree.Declarations[0].Body[0].Children[0]
		if got := shape(n); got != tc.want {
			t.Errorf("%s: got %s, want %s", tc.expression, got, tc.want)
		}
	}
}

func TestNothingDefaultsRejected(t *testing.T) {
	for _, source := range []string{
		"on t\n return a otherwise\nend t",
		"on t\n return replace a otherwise b in s with c\nend t",
		"on t\n put 1 into the optional k of m\nend t",
		"on t\n set the optional k of m to 1\nend t",
		"on t\n delete the optional k of m\nend t",
		"on t\n add 1 to the optional (k) of m\nend t",
		"on t\n subtract 1 from the optional k of m\nend t",
		"on t\n multiply the optional k of m by 2\nend t",
		"on t\n divide the optional k of m by 2\nend t",
		"on t\n put 1 into the b of the optional a of m\nend t",
	} {
		if _, err := Parse(source); err == nil {
			t.Errorf("accepted %q", source)
		}
	}
}

func TestNothingDefaultsContinuation(t *testing.T) {
	tree, err := Parse("on t\n return a otherwise -- note\n b\nend t")
	if err != nil {
		t.Fatal(err)
	}
	n := tree.Declarations[0].Body[0].Children[0]
	if n.Kind != "binary" || n.Text != "otherwise" {
		t.Fatalf("got %s %q", n.Kind, n.Text)
	}
	// An operand named `otherwise` at a line's end does not continue it:
	// the next line is its own statement, and may itself start with the
	// word as a Command Call.
	tree, err = Parse("on t\n put otherwise into x\n otherwise 1\nend t")
	if err != nil {
		t.Fatal(err)
	}
	body := tree.Declarations[0].Body
	if len(body) != 2 || body[1].Kind != "command" || body[1].Text != "otherwise" {
		t.Fatalf("got %d statements, second %s %q", len(body), body[1].Kind, body[1].Text)
	}
	// A Lambda's result may be defaulted inside the Lambda.
	tree, err = Parse("on t\n put given x: x otherwise 0 into f\nend t")
	if err != nil {
		t.Fatal(err)
	}
	lambda := tree.Declarations[0].Body[0].Children[0]
	if lambda.Kind != "lambda" || lambda.Children[0].Text != "otherwise" {
		t.Fatalf("lambda body: got %s %q", lambda.Kind, lambda.Children[0].Text)
	}
}
