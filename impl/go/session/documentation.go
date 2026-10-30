package session

import (
	talk "northtalk.org/go"
	"northtalk.org/go/internal/analysis"
	"northtalk.org/go/internal/docs"
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
	return h.functionDocumentation(v)
}

func (h *Host) functionDocumentation(v any) (string, bool) {
	unit, carried := docs.FunctionUnit(v)
	if !carried {
		return docs.Function(v)
	}
	name, _, _, ok := docs.FunctionHead(v)
	return h.sources[unit][foldName(name)], ok
}

// Like the Zig Session Host, retain every defining source version across
// Reload, Library replacement and Restore. This archive only grows during a
// Session; restoring an earlier checkpoint must not discard later versions.
func (h *Host) harvestSources() {
	if docs.ScriptUnits == nil {
		return
	}
	units, err := docs.ScriptUnits(h.script)
	must(err)
	if h.sources == nil {
		h.sources = map[[32]byte]map[string]string{}
	}
	for _, unit := range units {
		if _, known := h.sources[unit.Identity]; known {
			continue
		}
		declarations, err := analysis.Source(unit.Source)
		must(err) // These exact sources have already loaded successfully.
		functions := map[string]string{}
		for _, d := range declarations {
			if d.Kind == "function" {
				functions[foldName(d.Name)] = d.Doc
			}
		}
		h.sources[unit.Identity] = functions
	}
}
