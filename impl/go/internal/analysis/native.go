//go:build !talk_zig_experimental

package analysis

import (
	"errors"
	"slices"
	"sort"
	"strings"

	"github.com/odogono/odgn-talk/impl/go/internal/check"
	"github.com/odogono/odgn-talk/impl/go/internal/generated"
	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
)

func problem(err error) error {
	var e *syntax.Error
	if errors.As(err, &e) {
		return &Problem{e.Code, e.Pos.Line, e.Pos.Column, e.Incomplete, e.TrailingEntry}
	}
	return err
}
func ParseEntry(source string, handlers, bound []string) (*Entry, error) {
	kind, node, err := syntax.ParseEntry(source, func(name string) bool { return slices.Contains(handlers, name) })
	if err != nil {
		return nil, problem(err)
	}
	if kind == "" {
		kind = "empty"
	}
	e := &Entry{Kind: kind, Doc: "none"}
	switch syntax.LeadingDoc(source) {
	case syntax.DocPending:
		e.Doc = "pending"
	case syntax.DocAttached:
		e.Doc = "attached"
	}
	if kind == "declaration" {
		e.Declarations, err = Source(source)
	} else {
		e.Implicit = implicitVariables(node, bound)
	}
	return e, err
}

func Source(source string) ([]Declaration, error) {
	tree, err := syntax.Parse(source)
	if err != nil {
		return nil, problem(err)
	}
	var out []Declaration
	for i, n := range tree.Declarations {
		limit := len(source)
		if i+1 < len(tree.Declarations) {
			limit = tree.Declarations[i+1].Token.Start
		}
		end := n.Token.End
		for _, t := range tree.Tokens {
			if t.Start >= n.Token.Start && t.Start < limit && t.Kind != syntax.LineBreak && t.Kind != syntax.EOF {
				end = max(end, t.End)
			}
		}
		head := n.NameToken.End
		if n.Kind == "function" || n.Kind == "handler" || n.Kind == "use" {
			at := sort.Search(len(tree.Tokens), func(i int) bool { return tree.Tokens[i].Start >= n.Token.Start })
			for k := at; k < len(tree.Tokens) && tree.Tokens[k].Kind != syntax.LineBreak && tree.Tokens[k].Kind != syntax.EOF; k++ {
				head = tree.Tokens[k].End
			}
		}
		d := Declaration{Kind: n.Kind, Name: n.Text, Private: n.Private, Span: Span{n.Token.Start, end, n.Token.Pos.Line, strings.Count(source[:end], "\n") + 1}, Signature: source[n.Token.Start:head], Doc: tree.Documentation(n)}
		if n.Kind == "handler" {
			d.Word = strings.Split(n.Text, ":")[0]
		}
		if n.Kind == "function" {
			required := 0
			for _, param := range n.Params {
				if len(param.Children) == 0 {
					required++
				}
			}
			d.Arity = []int{required, len(n.Params)}
		}
		if n.Kind == "variable" && len(n.Children) > 0 {
			eq := n.NameToken.End + strings.Index(source[n.NameToken.End:], "=")
			text := strings.Trim(source[eq+1:end], " \t")
			d.Initializer = &text
		}
		if n.Kind == "use" {
			for _, param := range n.Params {
				local := param.Text
				if len(n.Children) > 0 {
					local = n.Children[0].Text
				}
				d.Imports = append(d.Imports, Import{param.Text, local})
			}
		}
		out = append(out, d)
	}
	return out, nil
}

var catalogue = func() *Catalog {
	c := &Catalog{InspectReader: generated.InspectReader}
	for _, b := range generated.Builtins.Builtin {
		c.Builtins = append(c.Builtins, Builtin{b.Name, b.Call, b.Gives})
	}
	for name, source := range generated.StandardLibraries {
		c.Libraries = append(c.Libraries, Library{name, source})
	}
	return c
}()

// Catalogue returns immutable Core data.
func Catalogue() *Catalog { return catalogue }
func ValidMessageName(name string, arity int) bool {
	return syntax.ValidComputedMessageName(name, arity)
}

// Collect whole-Entry bindings while excluding Lambdas and names bound by
// patterns. Pattern locals shadow throughout the Entry, regardless of order.
func implicitVariables(node *syntax.Node, bound []string) []string {
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
		if s != nil && s.Kind != "literal" && s.Text != "it" && s.Text != "_" && !seen[s.Text] && !pattern[s.Text] && !slices.Contains(bound, s.Text) {
			seen[s.Text] = true
			out = append(out, s.Text)
		}
	}
	return out
}
