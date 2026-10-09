// Package session implements chapter 12's ordinary Session Host. It owns no
// terminal or filesystem: its Environment supplies I/O and Clock readings.
package session

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	talk "github.com/odogono/odgn-talk/impl/go"
	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
	"github.com/odogono/odgn-talk/impl/go/store"
)

// Item is one Transcript record. Kind is input, read, clock, answer, comment or
// output; an input's continuation lines are folded into Text with LF.
type Item struct {
	Kind, Text, Call string
	At               time.Time
}

// Environment supplies host effects. Callbacks run synchronously; callers
// serialize Input, Read and Tick. Record receives every printed line as well
// as recorded inputs and real Clock readings. Trace receives canonical lines.
type Environment struct {
	Objects          func(*Objects) map[string]*talk.Object
	ResolveObject    func(kind, id string) (any, bool)
	ObjectTranscript []Item
	Now              func() time.Time
	Record           func(Item)
	Trace            func(string)
	ReadFile         func(string) (string, error)
	WriteFile        func(directory, file, source string) error
	ReadStoreFile    func(path string) (string, error)
	WriteStoreFile   func(path, source string) error
}

type Waiting struct {
	Kind string
	At   time.Time
}
type placement struct{ line, col int }
type declaration struct {
	kind, source, library string
	names                 []string
	uses                  []use
}
type use struct{ name, local string }
type entryRun struct{ delivery, run string }
type segment struct {
	end   string
	until time.Time
	calls bool
}
type event struct {
	kind, run, delivery, outcome string
	seg                          segment
	line                         string
}
type mock struct {
	capability, operation string
	mode                  talk.Mode
}
type stub struct {
	value   talk.Value
	failure *talk.ScriptError
}
type library struct {
	added    string
	compiled *talk.Library
}
type saved struct {
	bytes                        []byte
	declarations                 []declaration
	implicit                     map[string]bool
	placements                   map[string]placement
	expressions                  map[string]bool
	inspections                  map[string]bool
	segments                     map[string]segment
	stubs                        map[string][]stub
	latest                       entryRun
	limits                       map[string]int64
	virtual, lastClock, deadline time.Time
	virtualOn, hasClock          bool
	lastEntry, units             int
	observation                  observation
}

// Host turns Entries and Session Commands into ordinary Group inputs.
// Foreground bookkeeping reads only the Trace; Inspect is reserved for the
// three explicit inspection commands, each of which is a vars Host Input.
type Host struct {
	// rewound is whether the last Pump returned rewound.
	rewound                      bool
	objectItems                  []Item
	objectSession                *Objects
	objectBindings               map[string]*talk.Object
	inspecting                   bool
	reader                       *talk.Value
	env                          Environment
	core                         *talk.Core
	group                        *talk.Group
	script                       *talk.Script
	declarations                 []declaration
	implicit                     map[string]bool
	placements                   map[string]placement
	expressions                  map[string]bool
	inspections                  map[string]bool
	segments                     map[string]segment
	foreground, latest           entryRun
	events                       []event
	writes                       map[string]talk.Value
	reads, pending               map[string]*talk.Call
	readOrder                    []string
	mocks                        []mock
	granted                      map[string]string
	bindings                     map[string]string
	stores                       *store.Stores
	grants                       map[string]*talk.Grant
	stubs                        map[string][]stub
	libraries                    map[string]library
	libraryOrder                 []string
	saves                        map[string]saved
	limits                       map[string]int64
	virtual, lastClock, deadline time.Time
	virtualOn, hasClock          bool
	lastEntry, units             int
	waiting                      Waiting
	recording                    *string
	observation                  observation
	measuring                    bool // the next Entry's Run is a Fuel Measurement
}

func New(env Environment) *Host {
	if env.Now == nil {
		env.Now = time.Now
	}
	return &Host{env: env, bindings: map[string]string{}, stores: store.New(store.SessionQuotas()), core: talk.New(), implicit: map[string]bool{}, placements: map[string]placement{}, expressions: map[string]bool{}, inspections: map[string]bool{}, segments: map[string]segment{}, writes: map[string]talk.Value{}, reads: map[string]*talk.Call{}, pending: map[string]*talk.Call{}, granted: map[string]string{}, grants: map[string]*talk.Grant{}, stubs: map[string][]stub{}, libraries: map[string]library{}, saves: map[string]saved{}, limits: map[string]int64{}, units: 1, waiting: Waiting{Kind: "prompt"}, observation: newObservation()}
}
func (h *Host) Source() string          { return sourceOf(h.declarations) }
func (h *Host) Started() bool           { return h.group != nil }
func (h *Host) VirtualClock() bool      { return h.virtualOn }
func (h *Host) Waiting() Waiting        { return h.waiting }
func (h *Host) NextDeadline() time.Time { return h.deadline }
func (h *Host) record(i Item) {
	h.objectItems = append(h.objectItems, i)
	if h.env.Record != nil {
		h.env.Record(i)
	}
}
func (h *Host) recorded() {
	if h.recording != nil {
		h.record(Item{Kind: "input", Text: *h.recording})
		h.recording = nil
	}
}

// printed ends a Host call: trace and Fuel rows follow its ordinary output.
func (h *Host) printed(out []string) []string {
	h.recorded()
	out = append(out, h.observed()...)
	for _, s := range out {
		h.record(Item{Kind: "output", Text: s})
	}
	return out
}
func (h *Host) Input(source string) []string {
	s := strings.TrimRight(source, "\n")
	if name, _ := split(s); name == ":help" || name == ":quit" {
		return h.command(s)
	}
	h.recording = &s
	var out []string
	if strings.HasPrefix(source, ":") {
		out = h.command(s)
	} else {
		h.start()
		kind, node, err := syntax.ParseEntry(source, h.isHandler)
		if err != nil {
			out = h.refused(err, placement{}, 0)
		} else if !documentable(source, kind, node) {
			out = []string{"! bad arguments"}
		} else if kind == "declaration" {
			out = h.declare(describe(s, node), node)
		} else if kind != "" {
			_, out = h.run(s, kind == "expression", node)
		}
	}
	return h.printed(out)
}
func (h *Host) Read(line string) []string {
	for _, id := range h.readOrder {
		c := h.reads[id]
		if c != nil && callRun(id) == h.foreground.run && h.foreground.run != "" && c.Context().Err() == nil {
			delete(h.reads, id)
			h.record(Item{Kind: "read", Text: line})
			v, err := talk.Text(line)
			if err != nil {
				return []string{"! invalid value"}
			}
			c.Answer(v)
			return h.printed(h.pump())
		}
	}
	return nil
}
func (h *Host) Tick() []string {
	if h.group == nil {
		return nil
	}
	return h.printed(h.pump())
}
func (h *Host) start() {
	if h.group != nil {
		return
	}
	h.group = h.core.NewGroup(talk.GroupOptions{Name: "session", Trace: h})
	console, err := h.core.ConsoleCapability(consoleBinding{h}, talk.Costs{"write": {}, "read": {}})
	must(err)
	h.grants["console"], err = console.Grant([]string{"write", "read"}, nil)
	must(err)
	defs := map[string]*talk.CapabilityDef{}
	ops := map[string][]talk.Operation{}
	for _, m := range h.mocks {
		key := m.capability + "." + m.operation
		op := talk.Operation{Name: m.operation, Mode: m.mode, Result: talk.AnyShape}
		for range 8 {
			op.Args = append(op.Args, talk.Optional(talk.AnyShape))
		}
		switch m.mode {
		case talk.Immediate:
			op.Do = func(c *talk.Call, args []talk.Value) (talk.Value, error) {
				queue := h.stubs[key]
				if len(queue) == 0 {
					return talk.Nothing, errors.New("missing stub")
				}
				s := queue[0]
				h.stubs[key] = queue[1:]
				if s.failure != nil {
					return talk.Nothing, s.failure
				}
				return s.value, nil
			}
		case talk.Suspending:
			op.Start = func(c *talk.Call, args []talk.Value) error { h.pending[string(c.ID())] = c; return nil }
		case talk.FireAndForget:
			op.Result = talk.Shape{}
			op.Fire = func(c *talk.Call, args []talk.Value) error { return nil }
		}
		ops[m.capability] = append(ops[m.capability], op)
	}
	for name, operations := range ops {
		defs[name], err = h.core.DefineCapability(name, operations...)
		must(err)
	}
	for name, capability := range h.granted {
		if capability == "store" && defs[capability] == nil {
			defs[capability], err = h.core.StoreCapability(h.stores, storeCosts())
			must(err)
		}
		if capability == "clock" {
			defs[capability], err = h.core.ClockCapability(talk.Costs{"now": {}})
			must(err)
		}
		names := []string{}
		if capability == "store" {
			names = []string{"get", "set", "delete", "keys", "increment", "swap"}
		} else if capability == "clock" {
			names = []string{"now"}
		} else {
			for _, m := range h.mocks {
				if m.capability == capability {
					names = append(names, m.operation)
				}
			}
		}
		var binding any
		if capability == "store" {
			binding = h.bindings[name]
		}
		h.grants[name], err = defs[capability].Grant(names, binding)
		must(err)
	}
	h.objectSession = newObjects(h.core, h.group, func(i Item) { h.record(i) }, h.env.ObjectTranscript, h.env.ObjectTranscript == nil || hasEnvelopes(h.env.ObjectTranscript))
	h.objectBindings = map[string]*talk.Object{}
	if h.env.ObjectTranscript != nil {
		h.objectBindings = h.objectSession.preload()
	} else if h.env.Objects != nil {
		h.objectBindings = h.env.Objects(h.objectSession)
	}
	h.objectSession.initial(h.objectBindings)
	h.script, err = h.group.Load(talk.LoadOptions{Name: "session", Source: "", Grants: h.grants, Objects: h.objectBindings})
	must(err)
}
func must(err error) {
	if err != nil {
		panic(err)
	}
}
func (h *Host) Write(c *talk.Call, v talk.Value) error { h.writes[string(c.ID())] = v; return nil }
func (h *Host) ReadCall(c *talk.Call) error {
	h.reads[string(c.ID())] = c
	h.readOrder = append(h.readOrder, string(c.ID()))
	return nil
}

// consoleBinding keeps ConsoleImpl.Read distinct from the user's Read method.
type consoleBinding struct{ h *Host }

func (b consoleBinding) Write(c *talk.Call, v talk.Value) error { return b.h.Write(c, v) }
func (b consoleBinding) Read(c *talk.Call) error                { return b.h.ReadCall(c) }
func (h *Host) isHandler(name string) bool {
	for _, d := range h.declarations {
		// A Selector's first part names the Handler's Entries (chapter 12).
		if d.kind == "handler" && strings.Split(d.names[0], ":")[0] == name {
			return true
		}
		if d.kind == "use" {
			for _, u := range d.uses {
				if u.local == name {
					return libraryHandler(h.libraries[d.library].compiled, u.name)
				}
			}
		}
	}
	return h.implicit[name]
}
func libraryHandler(l *talk.Library, name string) bool {
	if l == nil {
		return false
	}
	tree, err := syntax.Parse(l.Source())
	if err != nil {
		return false
	}
	for _, n := range tree.Declarations {
		if n.Private {
			continue
		}
		if n.Kind == "handler" && n.Text == name {
			return true
		}
		if n.Kind == "use" {
			d := describe("", n)
			for _, u := range d.uses {
				if u.local == name {
					for _, imported := range l.Imports() {
						if imported.Name() == d.library {
							return libraryHandler(imported, u.name)
						}
					}
				}
			}
		}
	}
	return false
}

// NeedsMore classifies continuation with the same names as actual submission.
// A leading doc block waits for the declaration it documents, and `:fuel`
// waits for the whole Entry it measures.
func (h *Host) NeedsMore(source string) bool {
	if name, rest := split(source); (name == ":fuel" || name == ":inspect") && rest != "" {
		source = rest
	} else if strings.HasPrefix(source, ":") {
		return false
	}
	_, _, err := syntax.ParseEntry(source, h.isHandler)
	var e *syntax.Error
	return errors.As(err, &e) && e.Incomplete || err == nil && syntax.LeadingDoc(source) == syntax.DocPending
}

// documentable refuses a leading doc block that documents nothing: one
// followed by a statement, an expression or an Import, or by no Entry at all.
func documentable(source, kind string, node *syntax.Node) bool {
	switch syntax.LeadingDoc(source) {
	case syntax.DocPending:
		return false
	case syntax.DocAttached:
		return kind == "declaration" && node.Kind != "use"
	}
	return true
}
func (h *Host) has(name string) bool {
	if h.objectBindings[name] != nil {
		return true
	}
	for _, d := range h.declarations {
		if slices.Contains(d.names, name) {
			return true
		}
	}
	return h.implicit[name]
}
func sourceOf(ds []declaration) string {
	var b strings.Builder
	for _, d := range ds {
		b.WriteString(d.source)
		b.WriteByte('\n')
	}
	return b.String()
}
func describe(source string, n *syntax.Node) declaration {
	d := declaration{kind: n.Kind, source: source, names: []string{n.Text}}
	if n.Kind == "use" {
		d.library = n.Text
		d.names = nil
		for _, p := range n.Params {
			local := p.Text
			if len(n.Children) > 0 {
				local = n.Children[0].Text
			}
			d.uses = append(d.uses, use{p.Text, local})
			d.names = append(d.names, local)
		}
	}
	return d
}
func useDeclaration(library string, uses []use) declaration {
	d := declaration{kind: "use", library: library, uses: uses}
	var names []string
	for _, u := range uses {
		d.names = append(d.names, u.local)
		names = append(names, u.name)
	}
	d.source = "use " + strings.Join(names, ", ") + " from " + library
	if len(uses) == 1 && uses[0].local != uses[0].name {
		d.source += " as " + uses[0].local
	}
	return d
}
func (h *Host) declare(d declaration, n *syntax.Node) []string {
	reused := false
	for _, name := range d.names {
		reused = reused || h.has(name)
	}
	if !reused {
		if err := h.script.Extend(d.source); err != nil {
			return h.refused(err, placement{}, 0)
		}
		h.declarations = append(h.declarations, d)
		h.units++
		return nil
	}
	if d.kind == "variable" {
		for i, old := range h.declarations {
			if old.kind == "variable" && old.names[0] == d.names[0] {
				expr := "nothing"
				adjust := placement{}
				if len(n.Children) > 0 {
					// The initializer begins after the declaration's '=' token, preserving
					// its exact source spelling, including multiline fenced literals.
					// The '=' follows the name, so a leading doc block can't hold it.
					eq := n.NameToken.End + strings.Index(d.source[n.NameToken.End:], "=")
					expr = d.source[eq+1:]
					adjust.col = 4 - utf8.RuneCountInString(d.source[strings.LastIndex(d.source[:eq], "\n")+1:eq+1])
				}
				loaded, out := h.runAt("put "+expr+" into "+d.names[0], false, nil, adjust)
				if loaded {
					h.declarations[i] = d
				}
				return out
			}
		}
	}
	next := placed(h.declarations, d)
	offset := 0
	for _, old := range next {
		if old.source == d.source {
			break
		}
		offset += len(strings.Split(old.source, "\n"))
	}
	out, err := h.reloadFrom(next, false)
	if err != nil {
		return h.refused(err, placement{line: offset}, len(strings.Split(d.source, "\n")))
	}
	return out
}

// reloadFrom reloads the Script from next as the session source, carrying
// its Script Variables over. An error changes nothing.
func (h *Host) reloadFrom(next []declaration, keepMailbox bool) ([]string, error) {
	reports, err := h.script.Reload(sourceOf(next), talk.CarryVariables, talk.ReloadOptions{KeepMailbox: keepMailbox})
	if err != nil {
		return nil, err
	}
	h.declarations = next
	h.implicit = map[string]bool{}
	h.placements = map[string]placement{}
	h.units = 1
	h.deadline = time.Time{}
	return h.discarded(reports), nil
}

// placed is the session source with d in it: in place of the declarations
// whose names it reuses, or at the end.
func placed(declarations []declaration, d declaration) []declaration {
	next := []declaration{}
	done := false
	for _, old := range declarations {
		overlap := false
		for _, name := range old.names {
			overlap = overlap || slices.Contains(d.names, name)
		}
		if !overlap {
			next = append(next, old)
		} else if old.kind == "use" {
			var left []use
			for _, u := range old.uses {
				if !slices.Contains(d.names, u.local) {
					left = append(left, u)
				}
			}
			if len(left) > 0 {
				next = append(next, useDeclaration(old.library, left))
			}
		} else if !done && d.kind != "use" {
			next = append(next, d)
			done = true
		}
	}
	if !done {
		next = append(next, d)
	}
	return next
}

func (h *Host) run(source string, expression bool, node *syntax.Node) (bool, []string) {
	return h.runAt(source, expression, node, placement{})
}
func (h *Host) runAt(source string, expression bool, node *syntax.Node, adjust placement) (bool, []string) {
	n := h.lastEntry + 1
	for h.has(fmt.Sprintf("entry%d", n)) {
		n++
	}
	handler := fmt.Sprintf("entry%d", n)
	if node == nil {
		_, node, _ = syntax.ParseEntry(source, h.isHandler)
	}
	bound := h.implicitVariables(node)
	body := source
	if expression {
		body = "return " + body
	}
	var b strings.Builder
	for _, v := range bound {
		fmt.Fprintf(&b, "script variable %s\n", v)
	}
	fmt.Fprintf(&b, "on %s\n%s\nend %s\n", handler, body, handler)
	p := placement{line: len(bound) + 1 + adjust.line, col: adjust.col}
	if expression {
		p.col = 7
	}
	if err := h.script.Extend(b.String()); err != nil {
		return false, h.refused(err, p, len(strings.Split(source, "\n")))
	}
	h.lastEntry = n
	h.implicit[handler] = true
	h.placements[fmt.Sprintf("session+%d", h.units)] = p
	h.units++
	for _, v := range bound {
		h.declarations = append(h.declarations, declaration{kind: "variable", names: []string{v}, source: "script variable " + v})
	}
	message := talk.Message{Name: handler}
	if len(h.limits) > 0 {
		o := h.override()
		message.Limits = &o
	}
	id, _, err := h.script.Request(context.Background(), message)
	if err != nil {
		return true, h.refused(err, placement{}, 0)
	}
	h.foreground = entryRun{delivery: string(id)}
	h.latest = h.foreground
	if h.measuring {
		h.observation.measurements = append(h.observation.measurements, &measurement{entry: n, root: string(id), fuel: map[string]int64{}})
	}
	if h.inspecting {
		h.inspections[string(id)] = true
	}
	if expression {
		h.expressions[string(id)] = true
	}
	return true, h.pump()
}

func where(unit string, line, col int, p placement, length int) string {
	l := line - p.line
	if length < 0 || l < 1 || length > 0 && l > length {
		return fmt.Sprintf("%s:%d:%d", unit, line, col)
	}
	if l == 1 {
		col = max(1, col-p.col)
	}
	return fmt.Sprintf("%d:%d", l, col)
}
func (h *Host) refused(err error, p placement, length int) []string {
	var syntaxError *syntax.Error
	if errors.As(err, &syntaxError) {
		return []string{fmt.Sprintf("! %s at %d:%d", syntaxError.Code, syntaxError.Pos.Line, syntaxError.Pos.Column)}
	}
	var load *talk.LoadError
	if errors.As(err, &load) {
		var out []string
		for _, d := range load.Diagnostics {
			out = append(out, "! "+d.Code+" at "+where(d.Unit, d.Line, d.Col, p, length))
		}
		return out
	}
	var host *talk.HostError
	if errors.As(err, &host) {
		return []string{"! " + string(host.Code)}
	}
	panic(err)
}
func (h *Host) discarded(reports []talk.Report) []string {
	if h.objectSession != nil {
		h.objectSession.reports(reports)
	}
	h.observe(reports, nil)
	var out []string
	for _, r := range reports {
		if stop, ok := r.(*talk.Stop); ok {
			for _, run := range stop.DiscardedRuns {
				out = append(out, "! discarded "+string(run))
				delete(h.segments, string(run))
				if h.foreground.run == string(run) {
					h.foreground = entryRun{}
					h.waiting = Waiting{Kind: "prompt"}
				}
			}
		}
	}
	h.pruneCalls()
	return out
}

// Inspect is the explicit vars Host Input, also used to finish a corpus case.
func (h *Host) Inspect() talk.Inspection {
	h.recorded()
	if h.group == nil {
		return talk.Inspection{}
	}
	view := h.group.Inspect()
	h.objectSession.snapshot(view)
	return view
}

// MockOperation is a mock declaration used by independent Trace replay.
type MockOperation struct {
	Capability, Operation string
	Mode                  talk.Mode
}

func (h *Host) MockOperations() []MockOperation {
	var out []MockOperation
	for _, m := range h.mocks {
		out = append(out, MockOperation{m.capability, m.operation, m.mode})
	}
	return out
}
func (h *Host) Grants() map[string]string {
	out := map[string]string{}
	for name, cap := range h.granted {
		out[name] = cap
	}
	return out
}

// UserLibraries gives each Library as first added; replacements occur in Trace.
func (h *Host) UserLibraries() []talk.LibrarySource {
	var out []talk.LibrarySource
	for _, name := range h.libraryOrder {
		out = append(out, talk.LibrarySource{Name: name, Version: "1", Source: h.libraries[name].added})
	}
	return out
}

// GrantBinding is the recorded binding used for independent Session replay.
func (h *Host) GrantBinding(name string) string { return h.bindings[name] }
func storeCosts() talk.Costs {
	return talk.Costs{"get": {Fuel: 2}, "keys": {Fuel: 2}, "set": {Fuel: 4}, "delete": {Fuel: 4}, "increment": {Fuel: 4}, "swap": {Fuel: 4}}
}

func hasEnvelopes(items []Item) bool {
	for _, i := range items {
		if i.Kind == "envelope" {
			return true
		}
	}
	return false
}
func (h *Host) ReplayObjectItem(index int) { h.start(); h.objectSession.drain(index) }
func (h *Host) FinishObjectReplay() {
	if h.objectSession != nil {
		h.objectSession.finish()
	}
}

func (h *Host) ObjectTranscript() []Item {
	if !hasEnvelopes(h.objectItems) {
		return nil
	}
	return slices.Clone(h.objectItems)
}
