package northtalk

import (
	"context"
	"errors"
	"fmt"
	"github.com/odogono/odgn-talk/impl/go/internal/check"
	"github.com/odogono/odgn-talk/impl/go/internal/decimal"
	"github.com/odogono/odgn-talk/impl/go/internal/machine"
	coretrace "github.com/odogono/odgn-talk/impl/go/internal/trace"
	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
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

	mu           sync.Mutex
	core         *Core
	options      GroupOptions
	scripts      []*Script
	inputs       []delivery
	nextDelivery int64
	nextTimer    int64
	clock        time.Time
	pumping      bool
}
type Script struct {
	group    *Group
	name     string
	state    *machine.State
	limits   Limits
	queue    []workItem
	runs     []*execution
	active   *execution
	counters Counters
	owner    *Object
	reserved int
	debt     int64
}
type delivery struct {
	id      DeliveryID
	script  *Script
	message Message
	pending *Pending
	cancel  DeliveryID
	kind    string
	fields  map[string]string
	from    RunID
	during  *corevalue.Value // non-nil only for an internal error message
}
type execution struct {
	run        *machine.Run
	delivery   delivery
	id         RunID
	handler    string
	clause     int
	how        string
	deadline   *big.Int
	timerOrder int64
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
func (c *Core) NewGroup(o GroupOptions) *Group { return &Group{core: c, options: o} }
func (g *Group) Name() string                  { return g.options.Name }
func (g *Group) Script(name string) *Script    { g.mu.Lock(); defer g.mu.Unlock(); return g.script(name) }
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
	id := identity(o.Name, o.Source)
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
	// Grants and Object registration are the next implementation stage. No
	// valid handle can be constructed here yet; refuse supplied placeholders.
	if len(o.Grants) > 0 {
		return nil, g.refuse(InvalidValue, "Capability Grants are not available")
	}
	if o.Owner != nil || len(o.Objects) > 0 {
		return nil, g.refuse(WrongGroup, "Object is not registered in this Group")
	}
	objects := []string{}
	for name := range o.Objects {
		objects = append(objects, name)
	}
	unit, loadError := g.core.compile(o.Name, o.Source, check.Options{Objects: objects, PatternSize: limits.PatternSize})
	if loadError != nil {
		g.diagnostics(loadError)
		return nil, loadError
	}
	state, e := machine.InitializeBound(unit, g, corevalue.Value{}, nil)
	if e != nil {
		pos := e.(*machine.InitError).Instruction.Pos
		loadError = &LoadError{[]Diagnostic{{Code: "initialiser failed", Unit: o.Name, Line: pos.Line, Col: pos.Column}}}
		g.diagnostics(loadError)
		return nil, loadError
	}
	s := &Script{group: g, name: o.Name, state: state, limits: limits, owner: o.Owner}
	g.mu.Lock()
	g.scripts = append(g.scripts, s)
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
	s := g.receiver(to)
	id, _, e := g.deliver(s, m, nil, false)
	return id, e
}
func (g *Group) Request(ctx context.Context, to *Object, m Message) (DeliveryID, *Pending, error) {
	return g.deliver(g.receiver(to), m, ctx, true)
}
func (g *Group) receiver(to *Object) *Script {
	g.mu.Lock()
	defer g.mu.Unlock()
	for _, s := range g.scripts {
		if s.owner == to && to != nil {
			return s
		}
	}
	return nil
}
func (g *Group) deliver(s *Script, m Message, ctx context.Context, request bool) (DeliveryID, *Pending, error) {
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
	refused := func(code HostErrorCode, detail string) (DeliveryID, *Pending, error) {
		g.recordRefusal(name, nil, fields, code)
		return "", nil, &HostError{code, detail}
	}
	g.mu.Lock()
	if s == nil || s.group != g {
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
	if m.Limits != nil {
		x := *m.Limits
		m.Limits = &x
		if x.FuelPerRun < 0 || x.AllocPerRun < 0 || x.MaxWait < 0 || x.MaxJoin < 0 || x.FuelPerRun > s.limits.FuelPerRun || x.AllocPerRun > s.limits.AllocPerRun || x.MaxWait > s.limits.MaxWait || x.MaxJoin > s.limits.MaxJoin || x.MaxWait%time.Millisecond != 0 {
			g.mu.Unlock()
			return refused(InvalidValue, "invalid limit override")
		}
	}
	queued := s.reserved
	if queued >= s.limits.MailboxDepth {
		g.mu.Unlock()
		g.recordRefusal(name, nil, fields, HostErrorCode("mailbox full"))
		return "", nil, ErrMailboxFull
	}
	g.nextDelivery++
	id := DeliveryID(fmt.Sprintf("d%d", g.nextDelivery))
	var p *Pending
	if request {
		if ctx == nil {
			ctx = context.Background()
		}
		p = &Pending{done: make(chan struct{})}
		name = "request"
	}
	s.reserved++

	d := delivery{id: id, script: s, message: m, pending: p, kind: name, fields: fields}
	g.inputs = append(g.inputs, d)
	if p != nil {
		p.stop = context.AfterFunc(ctx, func() { g.cancelDelivery(d) })
	}
	ready := g.options.OnReady
	g.mu.Unlock()
	if ready != nil {
		ready()
	}
	return id, p, nil
}
func validGroup(v corevalue.Value, g *Group) bool {
	if v.Kind == corevalue.Function {
		return v.Function != nil && v.Function.Group == g
	}
	if v.Kind == corevalue.Object {
		o, ok := v.Object.Handle.(*Object)
		if !ok {
			return false
		}
		for _, s := range g.scripts {
			if s.owner == o {
				return true
			}
		}
		return false
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
	fields := map[string]string{"clock": InstantFromTime(now).String()}
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
	g.clock = now.Round(0).UTC()
	g.pumping = true
	inputs := g.inputs
	g.inputs = nil
	g.mu.Unlock()
	defer func() { g.mu.Lock(); g.pumping = false; g.mu.Unlock() }()

	for _, d := range inputs {
		if d.cancel != "" {
			g.record("cancel-delivery", true, []string{string(d.cancel)}, nil)
		} else {
			g.record(d.kind, true, []string{string(d.id)}, d.fields)
		}
	}
	g.record("pump", true, nil, fields)
	return g.runPump(o, inputs)
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
	d.pending.mu.Lock()
	settled := d.pending.settled
	d.pending.mu.Unlock()
	if settled {
		g.mu.Unlock()
		return
	}
	g.inputs = append(g.inputs, delivery{cancel: d.id, script: d.script, pending: d.pending})
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
			run := RunView{ID: x.id, Status: status, Handler: x.handler}
			if x.deadline != nil {
				run.Status, run.Wait, run.Until = Suspended, "wait", deadlineTime(x.deadline)
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
