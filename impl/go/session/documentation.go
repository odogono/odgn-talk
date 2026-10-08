package session

import (
	talk "github.com/odogono/odgn-talk/impl/go"
	"github.com/odogono/odgn-talk/impl/go/internal/docs"
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
	if ds := h.sessionDeclared(name); ds != nil {
		return docsOf(ds)
	}
	return docsOf(builtinDeclared(name))
}

// LibraryDocumentation finds a public Library export's Declaration
// Documentation from the Library's source, whether or not it is imported.
func (h *Host) LibraryDocumentation(library, name string) []Doc {
	return docsOf(h.libraryDeclared(library, name))
}

// FunctionDocumentation is the Declaration Documentation of a Function
// Value's defining code, even when calling it would raise `function gone`.
// A Lambda's is empty; false means the value is not a Function Value.
func (h *Host) FunctionDocumentation(v talk.Value) (string, bool) {
	return docs.Function(v)
}
