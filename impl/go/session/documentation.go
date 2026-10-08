package session

import (
	talk "github.com/odogono/odgn-talk/impl/go"
	"github.com/odogono/odgn-talk/impl/go/internal/docs"
	"github.com/odogono/odgn-talk/impl/go/internal/generated"
	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
)

// Doc is one declaration's Declaration Documentation, as a name lookup finds
// it. Handler Clauses are separate Docs, in declaration order.
type Doc struct {
	// Origin is "session", "builtin" or the defining Library's name.
	Origin string
	// Declaration is "function", "handler", "constant", "variable" or "builtin".
	Declaration string
	// Clause numbers a Handler Clause within its Selector from 1; otherwise 0.
	Clause int
	Text   string
}

// Documentation finds the Declaration Documentation of a current name or
// Handler Selector, as binding precedence resolves it: the session's own
// declarations and Imports, then the Built-ins. An Import resolves to its
// defining Library declaration. It executes nothing.
func (h *Host) Documentation(name string) []Doc {
	var out []Doc
	clause := 0
	for _, d := range h.declarations {
		switch d.kind {
		case "use":
			for _, u := range d.uses {
				if u.local == name {
					return h.LibraryDocumentation(d.library, u.name)
				}
			}
		case "handler":
			if d.names[0] == name {
				clause++
				out = append(out, Doc{"session", d.kind, clause, sourceDoc(d.source)})
			}
		default:
			if d.names[0] == name {
				return []Doc{{"session", d.kind, 0, sourceDoc(d.source)}}
			}
		}
	}
	if out != nil {
		return out
	}
	for _, b := range generated.Builtins.Builtin {
		if b.Name == name {
			return []Doc{{"builtin", "builtin", 0, b.Gives}}
		}
	}
	return nil
}

// LibraryDocumentation finds a public Library export's Declaration
// Documentation from the Library's source, whether or not it is imported.
func (h *Host) LibraryDocumentation(library, name string) []Doc {
	source, ok := generated.StandardLibraries[library]
	if l, added := h.libraries[library]; added {
		source, ok = l.compiled.Source(), true
	}
	if !ok {
		return nil
	}
	tree, err := syntax.Parse(source)
	if err != nil {
		return nil
	}
	var out []Doc
	for _, n := range tree.Declarations {
		if n.Private || n.Kind == "use" || n.Text != name {
			continue
		}
		clause := 0
		if n.Kind == "handler" {
			clause = len(out) + 1
		}
		out = append(out, Doc{library, n.Kind, clause, tree.Documentation(n)})
	}
	return out
}

// FunctionDocumentation is the Declaration Documentation of a Function
// Value's defining code, even when calling it would raise `function gone`.
// A Lambda's is empty; false means the value is not a Function Value.
func (h *Host) FunctionDocumentation(v talk.Value) (string, bool) {
	return docs.Function(v)
}

// sourceDoc is the documentation of the one declaration in a session source.
func sourceDoc(source string) string {
	tree, err := syntax.Parse(source)
	if err != nil || len(tree.Declarations) == 0 {
		return ""
	}
	return tree.Documentation(tree.Declarations[0])
}
