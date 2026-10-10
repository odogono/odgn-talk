package northtalk

import (
	"crypto/sha256"
	"fmt"
	"slices"

	"github.com/odogono/odgn-talk/impl/go/internal/check"
	"github.com/odogono/odgn-talk/impl/go/internal/lower"
	"github.com/odogono/odgn-talk/impl/go/internal/machine"
	"github.com/odogono/odgn-talk/impl/go/internal/shape"
	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
)

// Extend adds an Entry atomically, keeping existing frames and Function Values.
func (s *Script) Extend(source string) error {
	g := s.group
	_, ids, _, _ := libraryOptions(g.libraries)
	id := codeIdentity("extension", s.name, source, ids)
	extendedID := extendedIdentity(s.identity, id)
	fields := map[string]string{"source": corevalue.DisplayText(source), "identity": fmt.Sprintf("%x", extendedID)}
	if err := g.beginWorker(); err != nil {
		g.recordRefusal("extend", []string{s.name}, fields, ReentrantCall)
		return err
	}
	defer g.endWorker()
	g.record("extend", true, []string{s.name}, fields)
	if g.effectUnknown {
		return g.refuse(EffectStateUnknown, "Group has unresolved external effects")
	}
	state, err := s.prepareExtension(source)
	if err != nil {
		return err
	}
	added := state.Variables[len(s.state.Variables):]
	if size := s.persistent() + valuesSize(added); size > s.limits.PersistentState {
		return g.refuse(StateTooLarge, "extension exceeds Persistent State")
	}
	// The Home is stable; only its append-only code tables and new bindings change.
	for i, v := range state.Variables {
		state.Variables[i] = extensionHome(v, state, s.state)
	}
	for i, v := range state.Definitions {
		state.Definitions[i] = extensionHome(v, state, s.state)
	}
	for _, x := range s.runs {
		x.run.Base = append(slices.Clone(x.run.Base), added...)
	}
	s.state.Unit, s.state.Constants, s.state.Definitions, s.state.Variables = state.Unit, state.Constants, state.Definitions, state.Variables
	s.state.Libraries = state.Libraries
	s.extensions = append(s.extensions, source)
	s.identity = extendedID
	return nil
}

func valuesSize(vs []corevalue.Value) int64 {
	var n int64
	for _, v := range vs {
		n += machine.Size(v)
	}
	return n
}

func (s *Script) compileOptions() (check.Options, map[string][32]byte) {
	exports, ids, _, calls := libraryOptions(s.group.libraries)
	declarations := map[string]map[string]check.OperationCheck{}
	for name, grant := range s.grants {
		if grant.revoked && !grant.disabled {
			continue
		}
		declarations[name] = map[string]check.OperationCheck{}
		for op, kept := range grant.operations {
			if !kept {
				continue
			}
			d := grant.definition.ops[op]
			args := make([]shape.Shape, len(d.Args))
			for i, arg := range d.Args {
				args[i] = arg.inner
			}
			declarations[name][op] = check.OperationCheck{Mode: modeName(d.Mode), Args: args}
		}
	}
	objects := []string{}
	for name := range s.state.Objects {
		objects = append(objects, name)
	}
	return check.Options{Imports: exports, ImportCalls: calls, Objects: objects, ObjectProperties: objectProperties(s.state.Objects), OwnerProperties: ownerProperties(s.owner), PatternSize: s.limits.PatternSize, Grants: declarations}, ids
}

func (s *Script) prepareExtension(source string) (*machine.State, error) {
	unitName := fmt.Sprintf("%s+%d", s.name, len(s.extensions)+1)
	tree, err := syntax.Parse(source)
	if err != nil {
		p := err.(*syntax.Error)
		e := &LoadError{[]Diagnostic{{Code: p.Code, Message: p.Error(), Unit: unitName, Line: p.Pos.Line, Col: p.Pos.Column}}}
		s.group.diagnostics(e)
		return nil, e
	}
	old := s.state.Unit.Checked()
	for _, n := range tree.Declarations {
		names := []string{n.Text}
		if n.Kind == "use" {
			names = nil
			for _, p := range n.Params {
				name := p.Text
				if len(n.Children) > 0 {
					name = n.Children[0].Text
				}
				names = append(names, name)
			}
		}
		for _, name := range names {
			if _, ok := old.Symbols[name]; ok {
				return nil, s.group.refuse(NameReused, name)
			}
		}
	}
	options, _ := s.compileOptions()
	options.Existing = old
	checked := check.Check(tree, options)
	if len(checked.Diagnostics) > 0 {
		e := &LoadError{}
		for _, d := range checked.Diagnostics {
			e.Diagnostics = append(e.Diagnostics, Diagnostic{Code: d.Code, Message: d.Message, Unit: unitName, Line: d.Pos.Line, Col: d.Pos.Column})
		}
		s.group.diagnostics(e)
		return nil, e
	}
	unit, err := lower.Extend(checked, s.state.Unit, unitName)
	if err != nil {
		return nil, err
	}
	prospective := *s.state
	_, _, prospective.Libraries, _ = libraryOptions(s.group.libraries)
	state, err := machine.InitializeExtension(&prospective, unit)
	if err != nil {
		p := err.(*machine.InitError).Instruction.Pos
		e := &LoadError{[]Diagnostic{{Code: "initialiser failed", Unit: unitName, Line: p.Line, Col: p.Column}}}
		s.group.diagnostics(e)
		return nil, e
	}
	return state, nil
}

func extensionHome(v corevalue.Value, from, to *machine.State) corevalue.Value {
	if v.Function() != nil {
		fn := *v.Function()
		if fn.Owner == from {
			fn.Owner = to
		}
		if fn.CodeState == from {
			fn.CodeState = to
		}
		fn.Captures = slices.Clone(fn.Captures)
		for i := range fn.Captures {
			fn.Captures[i].Val = extensionHome(fn.Captures[i].Val, from, to)
		}
		v = v.WithFunction(&fn)
	}
	v = v.WithItems(slices.Clone(v.Items()))
	for i := range v.Items() {
		v.Items()[i] = extensionHome(v.Items()[i], from, to)
	}
	v = v.WithEntries(slices.Clone(v.Entries()))
	for i := range v.Entries() {
		v.Entries()[i].Val = extensionHome(v.Entries()[i].Val, from, to)
	}
	return v
}

func extendedIdentity(previous, extension [32]byte) [32]byte {
	return sha256.Sum256([]byte(fmt.Sprintf("%x\nextend\n%x\n", previous, extension)))
}
