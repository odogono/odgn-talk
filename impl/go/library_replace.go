package northtalk

import (
	"fmt"
	"maps"

	"github.com/odogono/odgn-talk/impl/go/internal/machine"
	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
)

// ReplaceLibrary validates every transitive dependent before stopping any Run.
func (g *Group) ReplaceLibrary(l *Library, carry CarryOver) ([]Report, error) {
	if l == nil {
		return nil, &HostError{InvalidValue, "nil Library"}
	}
	fields := map[string]string{"identity": fmt.Sprintf("%x", l.id), "source": corevalue.DisplayText(l.Source()), "carry": "no"}
	if carry == CarryVariables {
		fields["carry"] = "yes"
	}
	if e := g.beginWorker(); e != nil {
		g.recordRefusal("replace-library", []string{l.Name()}, fields, ReentrantCall)
		return nil, e
	}
	defer g.endWorker()
	g.record("replace-library", true, []string{l.Name()}, fields)
	if g.effectUnknown {
		return nil, g.refuse(EffectStateUnknown, "Group has unresolved external effects")
	}
	if standardLibraries()[l.Name()] != nil {
		return nil, g.refuse(ReservedName, l.Name())
	}
	if g.libraries[l.Name()] == nil {
		return nil, g.refuse(LibraryMismatch, l.Name())
	}
	if carry != ResetVariables && carry != CarryVariables {
		return nil, g.refuse(InvalidValue, "invalid carry policy")
	}
	for _, dep := range l.imports {
		held := g.libraries[dep.Name()]
		if held == nil || held.id != dep.id {
			return nil, g.refuse(LibraryMismatch, dep.Name())
		}
	}
	old := g.libraries
	candidate := maps.Clone(old)
	candidate[l.Name()] = l
	changed := map[string]bool{l.Name(): true}
	// Recompile in dependency order, preserving each Library's own declarations.
	var rebuild func(string) error
	rebuilt := map[string]bool{l.Name(): true}
	rebuild = func(name string) error {
		if rebuilt[name] {
			return nil
		}
		original := old[name]
		for _, dep := range original.imports {
			if reachesLibrary(dep, l.Name(), map[*Library]bool{}) {
				if e := rebuild(dep.Name()); e != nil {
					return e
				}
			}
		}
		if reachesLibrary(original, l.Name(), map[*Library]bool{}) {
			declarations := GrantDecls{}
			// The original check options retain the declarations for private and
			// unused calls, which must remain valid on recompilation.
			for grant, ops := range original.state.Unit.Checked().Options.Grants {
				declarations[grant] = map[string]OperationCheck{}
				for op, d := range ops {
					args := []Shape{}
					for _, a := range d.Args {
						args = append(args, Shape{a})
					}
					mode := Immediate
					if d.Mode == "suspending" {
						mode = Suspending
					} else if d.Mode == "fire-and-forget" {
						mode = FireAndForget
					}
					declarations[grant][op] = OperationCheck{mode, args}
				}
			}
			replacement, e := g.core.compileLibrary(original.source, candidate, declarations)
			if e != nil {
				if load, ok := e.(*LoadError); ok {
					g.diagnostics(load)
				}
				return e
			}
			candidate[name] = replacement
			changed[name] = true
		}
		rebuilt[name] = true
		return nil
	}
	for _, name := range sortedKeys(old) {
		if e := rebuild(name); e != nil {
			return nil, e
		}
	}
	g.libraries = candidate
	committed := false
	defer func() {
		if !committed {
			g.libraries = old
		}
	}()
	type replacement struct {
		s     *Script
		state *machine.State
	}
	replacements := []replacement{}
	for _, s := range g.scripts {
		affected := false
		for _, source := range append([]string{s.source}, s.extensions...) {
			tree, _ := syntax.Parse(source)
			for _, n := range tree.Declarations {
				if n.Kind == "use" && changed[n.Text] {
					affected = true
				}
			}
		}
		if !affected {
			continue
		}
		state, e := s.prepareReload(s.source, carry)
		if e != nil {
			return nil, e
		}
		// Rebuild extensions without publishing the prospective Home.
		temporary := *s
		temporary.extensions = nil
		temporary.state = state
		temporary.runs = nil
		temporary.queue = nil
		temporary.active = nil
		for _, source := range s.extensions {
			next, e := temporary.prepareExtension(source)
			if e != nil {
				return nil, e
			}
			for i, v := range next.Variables {
				next.Variables[i] = extensionHome(v, next, state)
			}
			for i, v := range next.Definitions {
				next.Definitions[i] = extensionHome(v, next, state)
			}
			state.Unit, state.Constants, state.Definitions, state.Variables = next.Unit, next.Constants, next.Definitions, next.Variables
			temporary.state = state
			temporary.extensions = append(temporary.extensions, source)
		}
		if carry == CarryVariables {
			oldVars := s.state.Variables
			if s.active != nil {
				oldVars = s.active.run.Base
			}
			for i, name := range state.Unit.Variables {
				for j, oldName := range s.state.Unit.Variables {
					if name == oldName {
						state.Variables[i] = oldVars[j]
						break
					}
				}
			}
		}
		if valuesSize(state.Variables) > s.limits.PersistentState {
			return nil, g.refuse(StateTooLarge, "carried Variables exceed Persistent State")
		}
		replacements = append(replacements, replacement{s, state})
	}
	var reports []Report
	// Complete every external cleanup before publishing any replacement.
	for _, r := range replacements {
		for _, x := range r.s.runs {
			g.abandonScopes(r.s, x, &reports)
			g.rollbackParticipant(r.s, x, &reports)
			if g.effectUnknown {
				var settlements []func()
				g.stopEffectGroup(&reports, &settlements, func(d delivery, run RunID, _ Verdict, _ Value, _ Outcome) {
					reports = append(reports, g.settleReloadDelivery(d.script, d, run)...)
				})
				for _, settle := range settlements {
					settle()
				}
				return reports, &HostError{EffectStateUnknown, "replacement cleanup failed"}
			}
		}
	}
	for _, r := range replacements {
		extensions := r.s.extensions
		rr, e := r.s.applyReload(r.state, r.s.source)
		reports = append(reports, rr...)
		if e != nil {
			return reports, e
		}
		r.s.extensions = extensions
		// The whole source-unit chain participates in the new identity.
		_, ids, _, _ := libraryOptions(candidate)
		for _, source := range extensions {
			r.s.identity = extendedIdentity(r.s.identity, codeIdentity("extension", r.s.name, source, ids))
		}
	}
	committed = true
	return reports, nil
}
