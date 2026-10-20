package northtalk

import (
	"slices"
)

const (
	LibraryMismatch HostErrorCode = "library mismatch"
	ReservedName    HostErrorCode = "reserved name"
)

type OperationCheck struct {
	Mode    Mode
	Args    []Shape
	Command bool     // also a Host Command (ADR 0094)
	Labels  []string // the Argument Labels a call may write (ADR 0115)
}

// GrantDecls supplies compile-time modes, argument Shapes, labels and `command` flags by source Grant name.
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
	needs   []OperationRef
	// decls are the Grant declarations it was compiled against, which each
	// Group's guest is given.
	decls GrantDecls
}

func (l *Library) Name() string          { return l.source.Name }
func (l *Library) Version() string       { return l.source.Version }
func (l *Library) Source() string        { return l.source.Source }
func (l *Library) Identity() [32]byte    { return l.id }
func (l *Library) Imports() []*Library   { return slices.Clone(l.imports) }
func (l *Library) Needs() []OperationRef { return slices.Clone(l.needs) }

// CompileLibrary checks immutable code; imports may also name the ambient stdlib.
// Calls are rechecked against the importing Script's own Grants at load.
func (c *Core) CompileLibrary(src LibrarySource, imports []*Library, declarations GrantDecls) (*Library, error) {
	for _, l := range imports {
		if l == nil {
			return nil, &HostError{InvalidValue, "nil Library"}
		}
	}
	return zigCompileLibrary(c, src, imports, declarations)
}

// AddLibrary registers code only after every direct dependency identity matches.
func (g *Group) AddLibrary(l *Library) error {
	if l == nil {
		return &HostError{InvalidValue, "nil Library"}
	}
	return g.backend.addLibrary(l)
}
