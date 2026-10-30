package northtalk

import (
	"context"
	"errors"
	"sync"
	"time"

	"northtalk.org/go/internal/decimal"
	"northtalk.org/go/internal/syntax"
	coretrace "northtalk.org/go/internal/trace"
	corevalue "northtalk.org/go/internal/value"
)

var ErrMailboxFull error = errors.New("mailbox full")

type Group struct {
	backend       groupBackend
	sessionExpose func(any)
	traceMu       sync.Mutex
	traceQueue    []string
	recording     bool

	mu             sync.Mutex
	core           *Core
	options        GroupOptions
	libraries      map[string]*Library
	objects        map[objectKey]*Object
	scripts        []*Script
	inputs         []delivery
	controlsQueued bool
	calls          map[CallID]*operationCall
	clock          time.Time
	pumping        bool
	runningPump    bool // refusals land at a crossing only during a Pump
}
type Script struct {
	source string

	group  *Group
	name   string
	limits Limits
	grants map[string]*Grant
	owner  *Object
}
type delivery struct {
	refusal  []string
	cancel   DeliveryID
	kind     string
	function *corevalue.Value
	target   *Object       // fixed initial recipient
	path     bool          // recheck the Object path before dispatch
	combined *combinedPump // a backend's combined admission and Pump (#1245)
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
		p.stop = nil
	}
	p.value = v
	p.err = e
	close(p.done)
}
func (c *Core) NewGroup(o GroupOptions) *Group {
	g := &Group{core: c, options: o, libraries: map[string]*Library{}}
	g.backend = newZigGroup(g)
	return g
}
func (g *Group) Name() string               { return g.options.Name }
func (g *Group) Script(name string) *Script { g.mu.Lock(); defer g.mu.Unlock(); return g.script(name) }

// ScriptNames returns the Group's Scripts' names in load order. It is Host
// inspection, not a worker call, so it records nothing in the Trace and may be
// called at any time, including from an Operation or hook inside a Pump: the
// Core never holds the Group's lock while Host code runs.
func (g *Group) ScriptNames() []string {
	g.mu.Lock()
	defer g.mu.Unlock()
	names := make([]string, len(g.scripts))
	for i, s := range g.scripts {
		names[i] = s.name
	}
	return names
}
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
	return g.backend.load(o)
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
	return g.admitWithReady(s, m, ctx, request, decision, address, true)
}

func (g *Group) admitWithReady(s *Script, m Message, ctx context.Context, request bool, decision *Deciding, address delivery, notify bool) (DeliveryID, *Pending, error) {
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
	// The guest knows only this Group's handles, so ownership is checked
	// here, in the native order; the guest admits everything else.
	if address.path && (address.target == nil || address.target.group != g) {
		return refused(WrongGroup, "Object does not belong to Group")
	}
	if !broadcast && !address.path && address.function == nil && (s == nil || s.group != g) {
		return refused(WrongGroup, "receiver does not belong to Group")
	}
	if address.function != nil || syntax.ValidMessageSelector(m.Name, len(m.Args)) {
		for _, v := range m.Args {
			if !validGroup(v.inner, g) {
				return refused(WrongGroup, "argument belongs to another Group")
			}
		}
	}
	var fn *Value
	if address.function != nil {
		fn = &Value{*address.function}
	}
	if address.combined != nil {
		return g.backend.(combinedBackend).queueCombined(s, address.target, fn, m, ctx, name, address.combined)
	}
	return g.backend.queue(s, address.target, fn, m, ctx, name, decision)
}
func validGroup(root corevalue.Value, g *Group) bool {
	stack := []corevalue.Value{root}
	for len(stack) > 0 {
		v := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if v.Kind == corevalue.Function {
			if v.Function() == nil || v.Function().Group != g {
				return false
			}
			continue
		}
		if v.Kind == corevalue.Object {
			if v.Object() == nil {
				return false
			}
			o, ok := v.Object().Handle.(*Object)
			if !ok || o == nil || o.group != g {
				return false
			}
			continue
		}
		stack = append(stack, v.Items()...)
		for _, p := range v.Entries() {
			stack = append(stack, p.Val)
		}
	}
	return true
}
func (g *Group) Pump(now time.Time, o PumpOptions) (PumpResult, error) {
	return g.pumpOwned(now, o, false)
}

// pumpOwned reuses a guard already claimed by a combined admission and Pump.
func (g *Group) pumpOwned(now time.Time, o PumpOptions, owned bool) (PumpResult, error) {
	return g.backend.pump(now, o)
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
func overrideDisplay(o LimitOverride) string {
	var pairs []corevalue.Pair
	for _, p := range []struct {
		k   string
		n   int64
		set LimitOverrideFields
	}{{"fuelPerRun", o.FuelPerRun, OverrideFuelPerRun}, {"allocPerRun", o.AllocPerRun, OverrideAllocPerRun}, {"maxWaitMs", int64(o.MaxWait / time.Millisecond), OverrideMaxWait}, {"maxJoin", int64(o.MaxJoin), OverrideMaxJoin}} {
		if p.n != 0 || o.Set&p.set != 0 {
			pairs = append(pairs, corevalue.Pair{Key: p.k, Val: corevalue.Fields{Kind: corevalue.Number, Number: decimal.FromInt(p.n)}.Value()})
		}
	}
	v, _ := corevalue.NewMap(pairs)
	return v.Display()
}
func (g *Group) Inspect() Inspection {
	return g.backend.inspect()
}
func (s *Script) Counters() Counters {
	return s.group.backend.counters(s)
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
	lines := []string{coretrace.Format(name, true, ids, fields), coretrace.Format("refused", false, nil, map[string]string{"code": corevalue.DisplayText(string(code))})}
	g.mu.Lock()
	if g.runningPump {
		g.inputs = append(g.inputs, delivery{kind: "refusal", refusal: lines})
		g.controlsQueued = true
		g.mu.Unlock()
		return
	}
	g.mu.Unlock()
	g.emit(lines...)
}
