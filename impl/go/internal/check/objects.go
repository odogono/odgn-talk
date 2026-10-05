package check

import "github.com/odogono/odgn-talk/impl/go/internal/syntax"

func literalKey(n *syntax.Node) (string, bool) {
	if n.Kind == "key" {
		return n.Text, true
	}
	k := unparen(n.Children[0])
	return k.Text, k.Kind == "literal" && k.Token.Kind == syntax.Text
}

// Parentheses preserve a literal key or a known Object root's meaning.
func unparen(n *syntax.Node) *syntax.Node {
	for n.Kind == "paren" {
		n = n.Children[0]
	}
	return n
}
