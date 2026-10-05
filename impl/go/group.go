package northtalk

import (
	"context"
	"errors"
	"fmt"
	"github.com/odogono/odgn-talk/impl/go/internal/check"
	"github.com/odogono/odgn-talk/impl/go/internal/decimal"
	"github.com/odogono/odgn-talk/impl/go/internal/machine"
	"github.com/odogono/odgn-talk/impl/go/internal/shape"
	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
	coretrace "github.com/odogono/odgn-talk/impl/go/internal/trace"
	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
	"maps"
	"math/big"
	"slices"
	"strconv"
	"sync"
	"time"
)

var ErrMailboxFull error = errors.New("mailbox full")

type Group struct {
	traceMu    sync.Mutex
	traceQueue []string
	recording  bool

	mu             sync.Mutex
	core           *Core
	options        GroupOptions
	libraries      map[string]*Library
	objects        map[objectKey]*Object
	scripts        []*Script
	inputs         []delivery
	unrouted       []delivery
	orphanReplies  []delivery
	stoppedSends   map[*Script]bool
	controlsQueued bool
	nextDelivery   int64
	nextBroadcast  int64
	calls          map[CallID]*operationCall
	nextTimer      int64
	clock          time.Time
	pumping        bool
}
type Script struct {
	group      *Group
	name       string
	state      *machine.State
	limits     Limits
	queue      []workItem
	runs       []*execution
	active     *execution
	counters   Counters
	grants     map[string]*Grant
	stopped    bool // protected by group.mu
	stopReason string
	owner      *Object
	reserved   int
	debt       int64
}
type delivery struct {
	id         DeliveryID
	broadcast  BroadcastID
	children   []delivery // selected when the Pump drains a Broadcast
	script     *Script
	message    Message
	pending    *Pending
	decision   *Deciding
	cancel     DeliveryID
	kind       string
	fields     map[string]string
	reason     string // unencoded Stop reason
	from       RunID
	during     *corevalue.Value // non-nil only for an internal error message
	settlement *operationSettlement
	reply      CallID
	function   *corevalue.Value
	target     *Object // fixed initial recipient
	path       bool    // recheck the Object path before dispatch
	after      *Object // climb from this previous owner, never from target
	parent     *Object // SetParent input
	object     *Object
}
type execution struct {
	raisesWritten int
	run           *machine.Run
	delivery      delivery
	id            RunID
	handler       string
	clause        int // selected body index; -1 until accepted
	how           string
	deadline      *big.Int
	memberTimers  []memberTimer
	timerOrder    int64
	parked        bool
	deciding      bool
	segment       int
	calls         int64
	stopReason    *string     // Stop landed at this Run's Host crossing
	scopes        []scopeSlot // surviving scopes in successful-opening order
	waitCall      CallID
	abandonCall   CallID
}
type workItem struct {
	delivery delivery
	run      *execution
}
type Pending struct {
	mu      sync.Mutex
	done    chan struct{}
	value   Value
	err     *ScriptError
	settled bool
	stop    func() bool
}

func (p *Pending) Done() <-chan struct{} { return p.done }
func (p *Pending) Result() (Value, *ScriptError) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.value, p.err
}
func (p *Pending) settle(v Value, e *ScriptError) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.settled {
		return
	}
	p.settled = true
	if p.stop != nil {
		p.stop()
	}
	p.value = v
	p.err = e
	close(p.done)
}
func (c *Core) NewGroup(o GroupOptions) *Group {
	return &Group{core: c, options: o, libraries: maps.Clone(standardLibraries())}
}
func (g *Group) Name() string               { return g.options.Name }
func (g *Group) Script(name string) *Script { g.mu.Lock(); defer g.mu.Unlock(); return g.script(name) }
func (g *Group) script(name string) *Script {
	for _, s := range g.scripts {
		if s.name == name {
			return s
		}
	}
	return nil
}
func (s *Script) Name() string { return s.name }
func (g *Group) record(name string, input bool, ids []string, fields map[string]string) {
	if g.options.Trace != nil {
		g.emit(coretrace.Format(name, input, ids, fields))
	}
}
func (g *Group) refuse(code HostErrorCode, detail string) error {
	g.record("refused", false, nil, map[string]string{"code": corevalue.DisplayText(string(code))})
	return &HostError{code, detail}
}
func (g *Group) Load(o LoadOptions) (*Script, error) {
	exports, ids, states, calls := libraryOptions(g.libraries)
	id := codeIdentity("script", o.Name, o.Source, ids)
	if e := g.beginWorker(); e != nil {
		g.recordRefusal("load", []string{o.Name}, map[string]string{"identity": fmt.Sprintf("%x", id)}, ReentrantCall)
		return nil, e
	}
	defer g.endWorker()
	g.record("load", true, []string{o.Name}, map[string]string{"identity": fmt.Sprintf("%x", id)})
	if g.Script(o.Name) != nil {
		return nil, g.refuse(NameReused, o.Name)
	}
	limits, e := effectiveLimits(o.Limits)
	if e != nil {
		g.record("refused", false, nil, map[string]string{"code": corevalue.DisplayText(string(InvalidValue))})
		return nil, e
	}
	grants := map[string]*Grant{}
	declarations := map[string]map[string]check.OperationCheck{}
	for name, template := range o.Grants {
		if template == nil || template.definition == nil {
			return nil, g.refuse(InvalidValue, "invalid Grant")
		}
		bound := &Grant{definition: template.definition, operations: map[string]bool{}, binding: template.binding}
		declarations[name] = map[string]check.OperationCheck{}
		for op := range template.operations {
			bound.operations[op] = true
			d := template.definition.ops[op]
			args := make([]shape.Shape, len(d.Args))
			for i, s := range d.Args {
				args[i] = s.inner
			}
			declarations[name][op] = check.OperationCheck{Mode: modeName(d.Mode), Args: args}
		}
		grants[name] = bound
	}
	if o.Owner != nil {
		if o.Owner.group != g {
			return nil, g.refuse(WrongGroup, "Object is not registered in this Group")
		}
		g.mu.Lock()
		invalid := o.Owner.disposed.Load() || o.Owner.owner != nil
		g.mu.Unlock()
		if invalid {
			return nil, g.refuse(InvalidValue, "Object is disposed or already owned")
		}
	}
	objects := []string{}
	bindings := map[string]corevalue.Value{}
	for name, object := range o.Objects {
		if object == nil || object.group != g {
			return nil, g.refuse(WrongGroup, "Object is not registered in this Group")
		}
		objects = append(objects, name)
		bindings[name] = object.Value().inner
	}
	me := corevalue.Value{}
	if o.Owner != nil {
		me = o.Owner.Value().inner
	}
	unit, loadError := g.core.compile(o.Name, o.Source, check.Options{Imports: exports, ImportCalls: calls, Objects: objects, ObjectProperties: objectProperties(bindings), OwnerProperties: ownerProperties(o.Owner), PatternSize: limits.PatternSize, Grants: declarations}, ids)
	if loadError != nil {
		g.diagnostics(loadError)
		return nil, loadError
	}
	state, e := machine.InitializeLinkedBound(unit, g, states, me, bindings)
	if e != nil {
		pos := e.(*machine.InitError).Instruction.Pos
		loadError = &LoadError{[]Diagnostic{{Code: "initialiser failed", Unit: o.Name, Line: pos.Line, Col: pos.Column}}}
		g.diagnostics(loadError)
		return nil, loadError
	}
	if o.GrantsAsUsed {
		used := map[string]map[string]bool{}
		tree, _ := syntax.Parse(o.Source)
		for _, decl := range tree.Declarations {
			syntax.Walk(decl, func(n *syntax.Node) bool {
				name, op := "", ""
				if n.Kind == "ask" || n.Kind == "tell" {
					name, op = n.Params[0].Text, n.Text
				}
				if n.Kind == "command" && n.Text == "say" {
					name, op = "console", "write"
				}
				if name != "" {
					if used[name] == nil {
						used[name] = map[string]bool{}
					}
					used[name][op] = true
				}
				return true
			})
		}
		for _, n := range tree.Declarations {
			if n.Kind != "use" {
				continue
			}
			if library := g.libraries[n.Text]; library != nil {
				for _, need := range library.needs {
					if used[need.Capability] == nil {
						used[need.Capability] = map[string]bool{}
					}
					used[need.Capability][need.Operation] = true
				}
			}
		}
		for name, grant := range grants {
			for op := range grant.operations {
				if scope := grant.definition.ops[op].Scope; used[name][op] && scope != nil && scope.Opens != "" {
					used[name][scope.Abandon] = true
				}
			}
			for op := range grant.operations {
				if !used[name][op] {
					delete(grant.operations, op)
				}
			}
			if len(grant.operations) == 0 {
				delete(grants, name)
			}
		}
	}
	s := &Script{grants: grants, group: g, name: o.Name, state: state, limits: limits, owner: o.Owner}
	g.mu.Lock()
	if o.Owner != nil {
		o.Owner.owner = s
	}
	g.scripts = append(g.scripts, s)
	for _, loaded := range g.scripts {
		loaded.state.ScriptNames = append(loaded.state.ScriptNames, o.Name)
		if loaded != s {
			state.ScriptNames = append(state.ScriptNames, loaded.name)
		}
	}
	g.mu.Unlock()
	return s, nil
}
func (g *Group) diagnostics(e *LoadError) {
	for _, d := range e.Diagnostics {
		g.record("diag", false, []string{d.Unit}, map[string]string{"code": corevalue.DisplayText(d.Code), "pos": fmt.Sprintf("%d:%d", d.Line, d.Col)})
	}
}
func (s *Script) Deliver(m Message) (DeliveryID, error) {
	id, _, e := s.group.deliver(s, m, nil, false)
	return id, e
}
func (s *Script) Request(ctx context.Context, m Message) (DeliveryID, *Pending, error) {
	return s.group.deliver(s, m, ctx, true)
}
func (g *Group) Deliver(to *Object, m Message) (DeliveryID, error) {
	id, _, e := g.enqueue(nil, m, nil, false, nil, to)
	return id, e
}
func (g *Group) Request(ctx context.Context, to *Object, m Message) (DeliveryID, *Pending, error) {
	return g.enqueue(nil, m, ctx, true, nil, to)
}
func (g *Group) deliver(s *Script, m Message, ctx context.Context, request bool) (DeliveryID, *Pending, error) {
	return g.enqueue(s, m, ctx, request, nil)
}
func (g *Group) enqueue(s *Script, m Message, ctx context.Context, request bool, decision *Deciding, objects ...*Object) (DeliveryID, *Pending, error) {
	address := delivery{}
	if len(objects) > 0 {
		address.target = objects[0]
		address.path = true
	}
	return g.admit(s, m, ctx, request, decision, address)
}
func (g *Group) admit(s *Script, m Message, ctx context.Context, request bool, decision *Deciding, address delivery) (DeliveryID, *Pending, error) {
	fields := map[string]string{"to": "unknown", "message": m.Name}
	if s != nil {
		fields["to"] = s.name
	}
	if len(m.Args) > 0 {
		fields["args"] = argsDisplay(m.Args)
	}
	if m.Limits != nil {
		fields["limits"] = overrideDisplay(*m.Limits)
	}
	name := "deliver"
	if request {
		name = "request"
	}
	if decision != nil {
		name = "decide"
	}
	if address.function != nil {
		name = "call-value"
		delete(fields, "to")
		delete(fields, "message")
		fields["fn"] = Value{*address.function}.String()
	}
	broadcast := address.kind == "broadcast"
	if broadcast {
		name = "broadcast"
		if decision != nil {
			name = "decide-broadcast"
		}
		delete(fields, "to")
	}
	refused := func(code HostErrorCode, detail string) (DeliveryID, *Pending, error) {
		g.recordRefusal(name, nil, fields, code)
		return "", nil, &HostError{code, detail}
	}
	g.mu.Lock()
	var target *Object
	path := address.path
	if path {
		target = address.target
		if target == nil || target.group != g {
			g.mu.Unlock()
			return refused(WrongGroup, "Object does not belong to Group")
		}
		fields["to"] = target.Value().String()
		s = g.nearestOwner(target)
	} else if s != nil {
		target = s.owner
	}
	if address.function != nil {
		s = g.script(address.function.Function.Home)
		if s != nil {
			target = s.owner
		}
	}
	if !broadcast && !path && (s == nil || s.group != g) {
		g.mu.Unlock()
		return refused(WrongGroup, "receiver does not belong to Group")
	}
	m.Args = slices.Clone(m.Args)
	for _, v := range m.Args {
		if !validGroup(v.inner, g) {
			g.mu.Unlock()
			return refused(WrongGroup, "argument belongs to another Group")
		}
	}
	limits := DefaultLimits()
	if s != nil {
		limits = s.limits
	}
	if m.Limits != nil {
		x := *m.Limits
		m.Limits = &x
		if x.FuelPerRun < 0 || x.AllocPerRun < 0 || x.MaxWait < 0 || x.MaxJoin < 0 || x.FuelPerRun > limits.FuelPerRun || x.AllocPerRun > limits.AllocPerRun || x.MaxWait > limits.MaxWait || x.MaxJoin > limits.MaxJoin || x.MaxWait%time.Millisecond != 0 {
			g.mu.Unlock()
			return refused(InvalidValue, "invalid limit override")
		}
	}
	if s != nil && s.reserved >= s.limits.MailboxDepth {
		g.mu.Unlock()
		g.recordRefusal(name, nil, fields, HostErrorCode("mailbox full"))
		return "", nil, ErrMailboxFull
	}
	var id DeliveryID
	var bid BroadcastID
	if broadcast {
		g.nextBroadcast++
		bid = BroadcastID(fmt.Sprintf("b%d", g.nextBroadcast))
	} else {
		g.nextDelivery++
		id = DeliveryID(fmt.Sprintf("d%d", g.nextDelivery))
	}
	var p *Pending
	if request {
		if ctx == nil {
			ctx = context.Background()
		}
		p = &Pending{done: make(chan struct{})}
	}
	if s != nil {
		s.reserved++
	}

	d := delivery{broadcast: bid, function: address.function, id: id, script: s, target: target, path: path, message: m, pending: p, decision: decision, kind: name, fields: fields}
	g.inputs = append(g.inputs, d)
	if p != nil {
		p.stop = context.AfterFunc(ctx, func() { g.cancelDelivery(d) })
	}
	if decision != nil {
		if ctx == nil {
			ctx = context.Background()
		}
		decision.stop = context.AfterFunc(ctx, func() { g.cancelDelivery(d) })
	}
	ready := g.options.OnReady
	g.mu.Unlock()
	if ready != nil {
		ready()
	}
	if broadcast {
		id = DeliveryID(bid)
	}
	return id, p, nil
}
func validGroup(v corevalue.Value, g *Group) bool {
	if v.Kind == corevalue.Function {
		return v.Function != nil && v.Function.Group == g
	}
	if v.Kind == corevalue.Object {
		if v.Object == nil {
			return false
		}
		o, ok := v.Object.Handle.(*Object)
		return ok && o != nil && o.group == g
	}
	for _, x := range v.Items {
		if !validGroup(x, g) {
			return false
		}
	}
	for _, p := range v.Entries {
		if !validGroup(p.Val, g) {
			return false
		}
	}
	return true
}
func (g *Group) Pump(now time.Time, o PumpOptions) (PumpResult, error) {
	now = now.Round(0).UTC()
	// Format the Host input without constructing a Value: refused Clocks can
	// fall outside the Instant range, and must not panic while being traced.
	fields := map[string]string{"clock": now.Format(time.RFC3339Nano)}
	if o.FuelSlice > 0 {
		fields["fuel-slice"] = strconv.FormatInt(o.FuelSlice, 10)
	}
	if o.FuelCap > 0 {
		fields["fuel-cap"] = strconv.FormatInt(o.FuelCap, 10)
	}
	g.mu.Lock()
	if g.pumping {
		g.mu.Unlock()
		g.recordRefusal("pump", nil, fields, ReentrantCall)
		return PumpResult{}, &HostError{ReentrantCall, "Pump inside Pump"}
	}
	if now.Year() < 1 || now.Year() > 9999 {
		g.mu.Unlock()
		g.recordRefusal("pump", nil, fields, InvalidValue)
		return PumpResult{}, &HostError{InvalidValue, "Clock outside year 1–9999"}
	}
	if now.Before(g.clock) {
		g.mu.Unlock()
		g.recordRefusal("pump", nil, fields, ClockBackwards)
		return PumpResult{}, &HostError{ClockBackwards, "Clock reading decreased"}
	}
	if o.FuelSlice < 0 || o.FuelCap < 0 {
		g.mu.Unlock()
		g.recordRefusal("pump", nil, fields, InvalidValue)
		return PumpResult{}, &HostError{InvalidValue, "negative Pump budget"}
	}
	g.clock = now
	g.pumping = true
	inputs := g.inputs
	g.inputs = nil
	g.controlsQueued = false
	g.mu.Unlock()
	defer func() { g.mu.Lock(); g.pumping = false; g.mu.Unlock() }()
	inputs = g.prepareBroadcasts(inputs)

	accepted := inputs[:0]
	for _, d := range inputs {
		if d.cancel != "" && d.decision != nil && d.decision.isSealed() {
			continue
		}
		accepted = append(accepted, d)
		if d.cancel != "" {
			g.record("cancel-delivery", true, []string{string(d.cancel)}, nil)
		} else {
			if d.kind == "stop" {
				g.record(d.kind, true, []string{d.script.name}, d.fields)
			} else if d.kind == "cancel-run" {
				g.record(d.kind, true, []string{d.fields["run"]}, nil)
			} else if d.kind == "revoke" {
				g.record(d.kind, true, []string{d.script.name}, d.fields)
			} else if d.kind == "dispose" || d.kind == "set-parent" {
				g.record(d.kind, true, nil, d.fields)
			} else if d.settlement != nil {
				g.record(d.kind, true, []string{string(d.reply)}, d.fields)
			} else {
				id := string(d.id)
				if d.broadcast != "" {
					id = string(d.broadcast)
				}
				g.record(d.kind, true, []string{id}, d.fields)
			}
		}
	}
	g.record("pump", true, nil, fields)
	return g.runPump(o, accepted)
}

func (r *RunEnd) isReport() {}
func (g *Group) beginWorker() error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.pumping {
		return &HostError{ReentrantCall, "worker call during execution"}
	}
	g.pumping = true
	return nil
}
func (g *Group) endWorker() { g.mu.Lock(); g.pumping = false; g.mu.Unlock() }
func (g *Group) cancelDelivery(d delivery) {
	g.mu.Lock()
	settled := false
	if d.decision != nil {
		settled = d.decision.isSealed()
	} else {
		d.pending.mu.Lock()
		settled = d.pending.settled
		d.pending.mu.Unlock()
	}
	if settled {
		g.mu.Unlock()
		return
	}
	id := d.id
	if d.broadcast != "" {
		id = DeliveryID(d.broadcast)
	}
	g.inputs = append(g.inputs, delivery{cancel: id, script: d.script, pending: d.pending, decision: d.decision})
	ready := g.options.OnReady
	g.mu.Unlock()
	if ready != nil {
		ready()
	}
}
func overrideDisplay(o LimitOverride) string {
	var pairs []corevalue.Pair
	for _, p := range []struct {
		k string
		n int64
	}{{"fuelPerRun", o.FuelPerRun}, {"allocPerRun", o.AllocPerRun}, {"maxWait", int64(o.MaxWait / time.Millisecond)}, {"maxJoin", int64(o.MaxJoin)}} {
		if p.n != 0 {
			pairs = append(pairs, corevalue.Pair{Key: p.k, Val: corevalue.Value{Kind: corevalue.Number, Number: decimal.FromInt(p.n)}})
		}
	}
	v, _ := corevalue.NewMap(pairs)
	return v.Display()
}
func (g *Group) Inspect() Inspection {
	if e := g.beginWorker(); e != nil {
		g.recordRefusal("vars", nil, nil, ReentrantCall)
		panic(e)
	}
	defer g.endWorker()
	g.record("vars", true, nil, nil)
	out := Inspection{}
	for _, s := range g.scripts {
		view := ScriptView{Name: s.name}
		for name, grant := range s.grants {
			if grant.disabled {
				view.DisabledGrants = append(view.DisabledGrants, name)
			}
		}
		slices.Sort(view.DisabledGrants)
		line := "vars " + s.name
		for j, name := range s.state.Unit.Variables {
			v := Value{s.state.Variables[j]}
			view.Vars = append(view.Vars, KV(name, v))
			line += " " + name + "=" + coretrace.Display(v.inner)
		}
		for _, x := range s.runs {
			status := Ready
			if x.run.Status == machine.Preempted {
				status = Preempted
			}
			if x.parked {
				status = Parked
			}
			run := RunView{ID: x.id, Status: status, Handler: x.handler}
			if x.deadline != nil {
				run.Status, run.Wait, run.Until = Suspended, "wait", deadlineTime(x.deadline)
			}
			if x.run.EventWait != nil {
				run.Status, run.Wait = Suspended, x.run.EventWait.Kind
			}
			if x.run.SendWait {
				run.Status, run.Wait, run.Calls = Suspended, "send-wait", []CallID{x.waitCall}
				if x.run.FunctionWait {
					run.Wait = "call-value-wait"
				}
				run.Until = time.Time{}
				if x.run.OperationWait {
					run.Wait = "ask-wait"
				}
			}
			if j := x.run.Join; j != nil && j.Waiting && !j.Ready {
				run.Status, run.Wait = Suspended, "join-end"
				run.Until = time.Time{}
				for _, m := range j.Members {
					if m.Reply == nil {
						run.Calls = append(run.Calls, CallID(m.ID))
					}
				}
			}
			view.Runs = append(view.Runs, run)
		}
		for _, item := range s.queue {
			if item.run != nil {
				continue
			}
			d := item.delivery
			m := d.message
			m.Args = slices.Clone(m.Args)
			if m.Limits != nil {
				copy := *m.Limits
				m.Limits = &copy
			}
			view.Mailbox = append(view.Mailbox, MessageView{Delivery: d.id, From: string(d.from), Message: m})
		}
		if g.options.Trace != nil {
			g.emit(line)
		}
		out.Scripts = append(out.Scripts, view)
	}
	return out
}
func (s *Script) Counters() Counters {
	if e := s.group.beginWorker(); e != nil {
		s.group.recordRefusal("counters", []string{s.name}, nil, ReentrantCall)
		panic(e)
	}
	defer s.group.endWorker()
	c := s.counters
	c.PersistentState = s.persistent()
	for _, item := range s.queue {
		if item.run == nil {
			c.MailboxLen++
		}
	}
	s.group.record("counters", true, []string{s.name}, nil)
	s.group.record("counters", false, []string{s.name}, map[string]string{"fuel": fmt.Sprint(c.FuelTotal), "alloc": fmt.Sprint(c.AllocTotal), "runs": fmt.Sprint(c.Runs), "faults": fmt.Sprint(c.Faults), "state": fmt.Sprint(c.PersistentState), "mailbox": fmt.Sprint(c.MailboxLen)})
	return c
}

// emit serializes the sink without holding the input queue lock. A queued call
// made by a sink callback can append records without recursively entering it.
func (g *Group) emit(lines ...string) {
	if g.options.Trace == nil {
		return
	}
	g.traceMu.Lock()
	g.traceQueue = append(g.traceQueue, lines...)
	if g.recording {
		g.traceMu.Unlock()
		return
	}
	g.recording = true
	g.traceMu.Unlock()
	for {
		g.traceMu.Lock()
		if len(g.traceQueue) == 0 {
			g.recording = false
			g.traceMu.Unlock()
			return
		}
		line := g.traceQueue[0]
		g.traceQueue = g.traceQueue[1:]
		g.traceMu.Unlock()
		g.options.Trace.Record(line)
	}
}
func (g *Group) recordRefusal(name string, ids []string, fields map[string]string, code HostErrorCode) {
	g.emit(coretrace.Format(name, true, ids, fields), coretrace.Format("refused", false, nil, map[string]string{"code": corevalue.DisplayText(string(code))}))
}
