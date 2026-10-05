package session

import (
	"slices"

	"github.com/odogono/odgn-talk/impl/go/internal/check"
	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
)

// Collect whole-Entry bindings while excluding Lambdas and names bound by
// patterns. Pattern locals shadow throughout the Entry, regardless of order.
func (h *Host) implicitVariables(node *syntax.Node) []string {
	if node == nil {
		return nil
	}
	var sites []*syntax.Node
	pattern := map[string]bool{}
	addPattern := func(n *syntax.Node) {
		for _, b := range check.Bindings(n) {
			pattern[b.Text] = true
		}
	}
	syntax.Walk(node, func(n *syntax.Node) bool {
		if n.Kind == "lambda" {
			return false
		}
		switch n.Kind {
		case "put", "add", "subtract":
			sites = append(sites, check.Root(n.Children[1]))
		case "multiply", "divide", "delete", "set":
			sites = append(sites, check.Root(n.Children[0]))
		case "replace":
			sites = append(sites, check.Root(n.Children[1]))
			sites = append(sites, check.Bindings(n.Children[0])...)
		case "replace-expression":
			sites = append(sites, check.Bindings(n.Children[0])...)
		case "let":
			addPattern(n.Children[0])
		case "repeat", "when", "catch", "event":
			for _, p := range n.Params {
				addPattern(p)
			}
		}
		return true
	})
	slices.SortStableFunc(sites, func(a, b *syntax.Node) int {
		x, y := a.BindingPos(), b.BindingPos()
		if x.Line != y.Line {
			return x.Line - y.Line
		}
		return x.Column - y.Column
	})
	seen := map[string]bool{}
	var out []string
	for _, s := range sites {
		if s != nil && s.Kind != "literal" && s.Text != "it" && s.Text != "_" && !seen[s.Text] && !pattern[s.Text] && !h.has(s.Text) {
			seen[s.Text] = true
			out = append(out, s.Text)
		}
	}
	return out
}
