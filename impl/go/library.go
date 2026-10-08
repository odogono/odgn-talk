package northtalk

import (
	"fmt"
	"maps"
	"slices"
	"strings"

	"github.com/odogono/odgn-talk/impl/go/internal/check"
	"github.com/odogono/odgn-talk/impl/go/internal/machine"
	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
)

const (
	LibraryMismatch HostErrorCode = "library mismatch"
	ReservedName    HostErrorCode = "reserved name"
)

type OperationCheck struct {
	Mode Mode
	Args []Shape
}

// GrantDecls supplies compile-time modes and argument Shapes by source Grant name.
type GrantDecls map[string]map[string]OperationCheck
type LibrarySource struct {
	Name    string
	Version string // The Host label is not part of code identity.
	Source  string
}

// Library holds immutable compiled code and unbound Constant values.
type Library struct {
	source  LibrarySource
	id      [32]byte
	imports []*Library
	exports map[string]check.Symbol
	state   *machine.State
	needs   []OperationRef
	calls   []check.OperationUse
}

func (l *Library) Name() string          { return l.source.Name }
func (l *Library) Version() string       { return l.source.Version }
func (l *Library) Source() string        { return l.source.Source }
func (l *Library) Identity() [32]byte    { return l.id }
func (l *Library) Imports() []*Library   { return slices.Clone(l.imports) }
func (l *Library) Needs() []OperationRef { return slices.Clone(l.needs) }

func libraryOptions(libraries map[string]*Library) (map[string]map[string]check.Symbol, map[string][32]byte, map[string]*machine.State, map[string][]check.OperationUse) {
	exports := map[string]map[string]check.Symbol{}
	ids := map[string][32]byte{}
	states := map[string]*machine.State{}
	calls := map[string][]check.OperationUse{}
	for name, l := range libraries {
		exports[name], ids[name], states[name], calls[name] = l.exports, l.id, l.state, l.calls
	}
	return exports, ids, states, calls
}

// CompileLibrary checks immutable code; imports may also name the ambient stdlib.
// Calls are rechecked against the importing Script's own Grants at load.
func (c *Core) CompileLibrary(src LibrarySource, imports []*Library, declarations GrantDecls) (*Library, error) {
	available := maps.Clone(standardLibraries())
	for _, l := range imports {
		if l == nil {
			return nil, &HostError{InvalidValue, "nil Library"}
		}
		if old := available[l.Name()]; old != nil && old.id != l.id {
			return nil, &HostError{LibraryMismatch, l.Name()}
		}
		available[l.Name()] = l
	}
	return c.compileLibrary(src, available, declarations)
}

func (c *Core) compileLibrary(src LibrarySource, available map[string]*Library, declarations GrantDecls) (*Library, error) {
	exports, ids, states, _ := libraryOptions(available)
	if tree, err := syntax.Parse(src.Source); err == nil {
		for _, n := range tree.Declarations {
			if n.Kind == "use" && (n.Text == src.Name || reachesLibrary(available[n.Text], src.Name, map[*Library]bool{})) {
				pos := n.Pos()
				return nil, &LoadError{[]Diagnostic{{Code: "import cycle", Unit: src.Name, Line: pos.Line, Col: pos.Column}}}
			}
		}
	}
	grants := map[string]map[string]check.OperationCheck{}
	for name, ops := range declarations {
		grants[name] = map[string]check.OperationCheck{}
		for op, d := range ops {
			args := make([]Shape, len(d.Args))
			copy(args, d.Args)
			decl := check.OperationCheck{Mode: modeName(d.Mode)}
			for _, arg := range args {
				decl.Args = append(decl.Args, arg.inner)
			}
			grants[name][op] = decl
		}
	}
	unit, rejected := c.compile(src.Name, src.Source, check.Options{Library: true, Imports: exports, Grants: grants}, ids)
	if rejected != nil {
		return nil, rejected
	}
	state, err := machine.InitializeLinked(unit, nil, states)
	if err != nil {
		pos := err.(*machine.InitError).Instruction.Pos
		return nil, &LoadError{[]Diagnostic{{Code: "initialiser failed", Unit: src.Name, Line: pos.Line, Col: pos.Column}}}
	}
	l := &Library{source: src, id: codeIdentity("library", src.Name, src.Source, ids), exports: map[string]check.Symbol{}, state: state}
	seen := map[string]bool{}
	needs := map[OperationRef]bool{}
	tree, _ := syntax.Parse(src.Source)
	for _, n := range tree.Declarations {
		if n.Kind == "use" {
			for _, need := range available[n.Text].needs {
				needs[need] = true
			}
			if !seen[n.Text] {
				l.imports = append(l.imports, available[n.Text])
				seen[n.Text] = true
			}
			continue
		}
		syntax.Walk(n, func(call *syntax.Node) bool {
			if call.Kind == "ask" || call.Kind == "tell" {
				needs[OperationRef{call.Params[0].Text, call.Text}] = true
			}
			if call.Kind == "command" && call.Text == "say" {
				needs[OperationRef{"console", "write"}] = true
			}
			return true
		})
		if n.Private {
			continue
		}
		symbol := check.Symbol{Kind: n.Kind, Name: n.Text, Maximum: len(n.Params)}
		if n.Kind == "constant" {
			symbol.Kind = "definition"
		}
		for _, body := range unit.Bodies {
			if body.Checked.Name == n.Text && body.Checked.MaySuspend {
				symbol.MaySuspend = true
			}
		}
		for _, param := range n.Params {
			if len(param.Children) == 0 {
				symbol.Required++
			}
		}
		l.exports[n.Text] = symbol
	}
	// The recorded calls are rechecked as this compilation called them.
	check.ResolveLines(tree, grants)
	l.calls = check.OperationUses(tree, src.Name)
	type siteKey struct {
		identity [32]byte
		pos      syntax.Position
	}
	sites := map[siteKey]bool{}
	for j := range l.calls {
		l.calls[j].Identity = l.id
		sites[siteKey{l.id, l.calls[j].Call.Pos()}] = true
	}
	// Direct calls precede imports, which retain their first source import order.
	for _, imported := range l.imports {
		for _, site := range imported.calls {
			key := siteKey{site.Identity, site.Call.Pos()}
			if !sites[key] {
				l.calls = append(l.calls, site)
				sites[key] = true
			}
		}
	}
	for need := range needs {
		l.needs = append(l.needs, need)
	}
	slices.SortFunc(l.needs, func(a, b OperationRef) int {
		if n := strings.Compare(a.Capability, b.Capability); n != 0 {
			return n
		}
		return strings.Compare(a.Operation, b.Operation)
	})
	return l, nil
}

// AddLibrary registers code only after every direct dependency identity matches.
func (g *Group) AddLibrary(l *Library) error {
	if l == nil {
		return &HostError{InvalidValue, "nil Library"}
	}
	fields := map[string]string{"identity": fmt.Sprintf("%x", l.id)}
	if err := g.beginWorker(); err != nil {
		g.recordRefusal("add-library", []string{l.Name()}, fields, ReentrantCall)
		return err
	}
	defer g.endWorker()
	g.record("add-library", true, []string{l.Name()}, fields)
	if standardLibraries()[l.Name()] != nil {
		return g.refuse(ReservedName, l.Name())
	}
	if g.libraries[l.Name()] != nil {
		return g.refuse(NameReused, l.Name())
	}
	for _, imported := range l.imports {
		held := g.libraries[imported.Name()]
		if held == nil || held.id != imported.id {
			return g.refuse(LibraryMismatch, imported.Name())
		}
	}
	g.libraries[l.Name()] = l
	return nil
}

func reachesLibrary(l *Library, name string, seen map[*Library]bool) bool {
	if l == nil || seen[l] {
		return false
	}
	if l.Name() == name {
		return true
	}
	seen[l] = true
	for _, imported := range l.imports {
		if reachesLibrary(imported, name, seen) {
			return true
		}
	}
	return false
}
