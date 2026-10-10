package session

import (
	"fmt"

	talk "github.com/odogono/odgn-talk/impl/go"
	"maps"
	"slices"
	"strings"
)

func cloneStubs(stubs map[string][]stub) map[string][]stub {
	out := map[string][]stub{}
	for key, queue := range stubs {
		out[key] = slices.Clone(queue)
	}
	return out
}
func (h *Host) save(name string) []string {
	bytes, err := h.group.Save()
	if err != nil {
		return h.refused(err, placement{}, 0)
	}
	h.saves[name] = saved{bytes: bytes, declarations: slices.Clone(h.declarations), implicit: maps.Clone(h.implicit), placements: maps.Clone(h.placements), expressions: maps.Clone(h.expressions), inspections: maps.Clone(h.inspections), segments: maps.Clone(h.segments), stubs: cloneStubs(h.stubs), latest: h.latest, limits: maps.Clone(h.limits), virtual: h.virtual, virtualOn: h.virtualOn, hasClock: h.hasClock, lastClock: h.lastClock, deadline: h.deadline, lastEntry: h.lastEntry, units: h.units, observation: h.observation.clone()}
	return []string{"saved " + name}
}
func (h *Host) restore(name string) []string {
	saved, ok := h.saves[name]
	if !ok {
		return refusal("no such save")
	}
	h.recorded()
	var libraries []*talk.Library
	for _, name := range h.libraryOrder {
		libraries = append(libraries, h.libraries[name].compiled)
	}
	group, result, err := h.core.Restore(saved.bytes, talk.RestoreOptions{Name: "session", Trace: h, Libraries: libraries, Grants: func(script, name string) *talk.Grant { return h.grants[name] }, Resolve: func(kind, id string) (any, bool) { return h.objectSession.resolve(kind, id, h.env.ResolveObject) }})
	if err != nil {
		return h.refused(err, placement{}, 0)
	}
	h.group = group
	h.objectSession.restored()
	h.objectSession.attach(group)
	h.objectSession.reports(result.Reports)
	h.script = group.Script("session")
	h.declarations = slices.Clone(saved.declarations)
	h.implicit = maps.Clone(saved.implicit)
	h.placements = maps.Clone(saved.placements)
	h.expressions = maps.Clone(saved.expressions)
	h.inspections = maps.Clone(saved.inspections)
	h.segments = maps.Clone(saved.segments)
	h.stubs = cloneStubs(saved.stubs)
	h.latest = saved.latest
	h.limits = maps.Clone(saved.limits)
	h.virtual = saved.virtual
	h.virtualOn = saved.virtualOn
	h.hasClock = saved.hasClock
	h.lastClock = saved.lastClock
	h.deadline = saved.deadline
	h.lastEntry = saved.lastEntry
	h.units = saved.units
	abandoned := h.observation.measurements
	h.observation = saved.observation.clone()
	h.observe(result.Reports, nil)
	h.foreground = entryRun{}
	h.waiting = Waiting{Kind: "prompt"}
	h.writes = map[string]talk.Value{}
	h.reads = map[string]*talk.Call{}
	h.prompts = map[string]*prompt{}
	h.notes = map[string]string{}
	h.pending = map[string]*talk.Call{}
	h.readOrder = nil
	for _, p := range result.Pending {
		c, err := group.Settle(p.ID, talk.Settlement{Adopt: true})
		must(err)
		if p.Grant == "console" {
			h.reads[string(p.ID)] = c
			h.readOrder = append(h.readOrder, string(p.ID))
		} else if p.Operation.Capability == "user" {
			h.prompts[string(p.ID)] = &prompt{call: c, prompt: promptOf(p.Operation.Operation, p.Args)}
		} else {
			h.pending[string(p.ID)] = c
		}
	}
	out := []string{"restored " + name}
	for _, run := range result.DiscardedRuns {
		delete(h.segments, string(run))
		out = append(out, "! discarded "+string(run))
	}
	// Work still pending in the replaced timeline is abandoned, not counted.
	for _, m := range abandoned {
		if !m.settled() {
			out = append(out, "fuel abandoned "+textForm(fmt.Sprintf("entry%d", m.entry)))
		}
	}
	return out
}
func (h *Host) library(rest string) []string {
	head, body, recorded := strings.Cut(rest, "\n")
	words := strings.Fields(head)
	if len(words) < 2 || len(words) > 3 || words[0] != "add" && words[0] != "replace" || !nameText.MatchString(words[1]) || recorded && len(words) != 2 || !recorded && len(words) != 3 {
		return refusal("bad arguments")
	}
	how, name := words[0], words[1]
	source := body + "\n"
	if !recorded {
		if h.env.ReadFile == nil {
			return refusal("bad arguments")
		}
		s, err := h.env.ReadFile(words[2])
		if err != nil {
			return refusal("bad arguments")
		}
		source = strings.TrimSuffix(s, "\n") + "\n"
		input := ":library " + how + " " + name + "\n" + strings.TrimSuffix(source, "\n")
		h.recording = &input
	}
	held, exists := h.libraries[name]
	if how == "add" && exists {
		return refusal("name reused")
	}
	if how == "replace" && !exists {
		return refusal("library mismatch")
	}
	var imports []*talk.Library
	for _, key := range h.libraryOrder {
		if key != name {
			imports = append(imports, h.libraries[key].compiled)
		}
	}
	definitions := talk.GrantDecls{"console": {"write": {Mode: talk.FireAndForget, Args: []talk.Shape{talk.AnyShape}}, "read": {Mode: talk.Suspending}}, "clock": {"now": {Mode: talk.Immediate}}, "user": userDecls()}
	for _, m := range h.mocks {
		if definitions[m.capability] == nil {
			definitions[m.capability] = map[string]talk.OperationCheck{}
		}
		args := []talk.Shape{}
		for range 8 {
			args = append(args, talk.Optional(talk.AnyShape))
		}
		definitions[m.capability][m.operation] = talk.OperationCheck{Mode: m.mode, Args: args}
	}
	decls := talk.GrantDecls{"console": definitions["console"]}
	for name, capability := range h.granted {
		decls[name] = definitions[capability]
	}
	l, err := h.core.CompileLibrary(talk.LibrarySource{Name: name, Version: "1", Source: source}, imports, decls)
	if err != nil {
		return h.refused(err, placement{}, -1)
	}

	staged := maps.Clone(h.libraries)
	candidate := held
	candidate.compiled = l
	if !exists {
		candidate.added = source
	}
	staged[name] = candidate
	var stageErr error
	if how == "replace" {
		staged, stageErr = h.rebuildLibraries(staged, name, decls)
	}
	// Even a failed dependent rebuild must reach the Group, which records the
	// attempted Host Input and refuses atomically with canonical diagnostics.
	var reports []talk.Report
	if how == "add" {
		err = h.group.AddLibrary(l)
	} else {
		reports, err = h.group.ReplaceLibrary(l, talk.CarryVariables)
	}
	if err != nil {
		return h.refused(err, placement{}, 0)
	}
	must(stageErr) // the same dependent graph succeeded inside the Group
	if !exists {
		h.libraryOrder = append(h.libraryOrder, name)
	}
	h.libraries = staged
	return h.discarded(reports)
}

// ReplaceLibrary recompiles dependents inside the Group. Stage the identical
// graph for the Host, so subsequent saves and new Library imports use current
// identities. Publish it only after the Group's replacement succeeds.
func (h *Host) rebuildLibraries(staged map[string]library, replaced string, decls talk.GrantDecls) (map[string]library, error) {
	done := map[string]bool{replaced: true}
	visiting := map[string]bool{}
	var compile func(string) error
	compile = func(name string) error {
		if done[name] {
			return nil
		}
		if visiting[name] {
			return &talk.HostError{Code: talk.LibraryMismatch, Detail: "Library cycle"}
		}
		visiting[name] = true
		held := staged[name]
		l := held.compiled
		var imports []*talk.Library
		changed := false
		for _, old := range l.Imports() {
			next := old
			if _, ok := staged[old.Name()]; ok {
				if err := compile(old.Name()); err != nil {
					return err
				}
				next = staged[old.Name()].compiled
			}
			changed = changed || old.Identity() != next.Identity()
			imports = append(imports, next)
		}
		if changed {
			next, err := h.core.CompileLibrary(talk.LibrarySource{Name: l.Name(), Version: l.Version(), Source: l.Source()}, imports, decls)
			if err != nil {
				return err
			}
			held.compiled = next
			staged[name] = held
		}
		visiting[name] = false
		done[name] = true
		return nil
	}
	for _, name := range h.libraryOrder {
		if err := compile(name); err != nil {
			return nil, err
		}
	}
	return staged, nil
}
