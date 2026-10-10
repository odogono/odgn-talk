package messagelayer

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"time"

	talk "github.com/odogono/odgn-talk/impl/go"
	"github.com/odogono/odgn-talk/impl/go/internal/messagehooks"
)

type handler func(*Session, fields) (map[string]any, error)

var handlers map[string]handler

func init() {
	handlers = map[string]handler{
		"hello":               (*Session).hello,
		"define-capability":   (*Session).defineCapability,
		"standard-capability": (*Session).standardCapability,
		"add":                 (*Session).add,
		"define-object-kind":  (*Session).defineObjectKind,
		"grant":               (*Session).grant,
		"new-group":           (*Session).newGroup,
		"load":                traced((*Session).load),
		"object":              traced((*Session).object),
		"set-parent":          traced((*Session).setParent),
		"dispose":             traced((*Session).dispose),
		"deliver":             traced((*Session).deliver),
		"request":             traced((*Session).request),
		"cancel-delivery":     traced((*Session).cancelDelivery),
		"broadcast":           traced((*Session).broadcast),
		"answer":              traced((*Session).answer),
		"fail":                traced((*Session).fail),
		"save":                (*Session).save,
		"fingerprint":         (*Session).fingerprint,
		"stop":                traced(scriptInput(func(s *talk.Script, f fields) error { r, err := f.str("reason"); s.Stop(r); return err })),
		"cancel-run":          traced(scriptInput(func(s *talk.Script, f fields) error { r, err := f.str("run"); s.CancelRun(talk.RunID(r)); return err })),
		"rewind-run":          traced(scriptInput(func(s *talk.Script, f fields) error { r, err := f.str("run"); s.RewindRun(talk.RunID(r)); return err })),
		"revoke":              traced(scriptInput(func(s *talk.Script, f fields) error { g, err := f.str("grant"); s.Revoke(g); return err })),
		"counters":            (*Session).counters,
		"grants":              (*Session).scriptGrants,
	}
}

// unsupported names the messages in the Spec that this adapter doesn't carry
// yet, so a Host can tell them from a typo.
var unsupported = map[string]bool{"compile-library": true, "add-library": true, "replace-library": true, "call": true, "decide": true, "inspect": true, "restore": true, "settle": true, "reload": true, "extend": true, "export-manifest": true}

// traced attaches the Trace records a Host Input made to its reply.
func traced(h handler) handler {
	return func(s *Session, f fields) (map[string]any, error) {
		ok, err := h(s, f)
		g, _ := s.group(f)
		if g == nil || g.trace == nil {
			return ok, err
		}
		lines := g.trace.take()
		if err != nil {
			if len(lines) > 0 {
				return nil, &tracedError{err, lines}
			}
			return nil, err
		}
		if ok == nil {
			ok = map[string]any{}
		}
		ok["trace"] = lines
		return ok, nil
	}
}

type tracedError struct {
	error
	trace []string
}

func (e *tracedError) Unwrap() error { return e.error }

func scriptInput(input func(*talk.Script, fields) error) handler {
	return func(s *Session, f fields) (map[string]any, error) {
		_, script, err := s.script(f)
		if err != nil {
			return nil, err
		}
		return nil, input(script, f)
	}
}

func (s *Session) group(f fields) (*group, error) {
	name, err := f.str("group")
	if err != nil {
		return nil, err
	}
	g := s.groups[name]
	if g == nil {
		return nil, protocolErrorf("no Group %q", name)
	}
	return g, nil
}

func (s *Session) script(f fields) (*group, *talk.Script, error) {
	g, err := s.group(f)
	if err != nil {
		return nil, nil, err
	}
	name, err := f.str("script")
	if err != nil {
		return nil, nil, err
	}
	script := g.g.Script(name)
	if script == nil {
		return nil, nil, protocolErrorf("no Script %q in Group %s", name, g.g.Name())
	}
	return g, script, nil
}

func (s *Session) hello(f fields) (map[string]any, error) {
	protocol, err := f.int("protocol")
	if err != nil {
		return nil, err
	}
	if protocol != Protocol {
		return nil, protocolErrorf("protocol %d isn't supported; this Core speaks %d", protocol, Protocol)
	}
	v := talk.CoreVersions()
	return map[string]any{"language": v.Language, "costModel": v.CostModel, "unicode": v.Unicode, "core": v.Core, "saveFormat": v.SaveFormat}, nil
}

func (s *Session) defineCapability(f fields) (map[string]any, error) {
	name, err := f.str("name")
	if err != nil {
		return nil, err
	}
	if lifecycle, _ := f.bool("segmentLifecycle"); lifecycle {
		return nil, protocolErrorf("segmentLifecycle isn't carried by this Message Layer yet")
	}
	var decls []operationDecl
	if err := f.decode("ops", &decls); err != nil {
		return nil, err
	}
	var ops []talk.Operation
	for _, d := range decls {
		op, err := d.operation()
		if err != nil {
			return nil, err
		}
		if op.SegmentBound {
			return nil, protocolErrorf("Segment-bound Operations aren't carried by this Message Layer yet")
		}
		ops = append(ops, s.bind(name, op))
	}
	def, err := s.core.DefineCapability(name, ops...)
	if err != nil {
		return nil, err
	}
	s.caps[name] = def
	return nil, nil
}

// bind makes each of op's callbacks an `op` request to the Host.
func (s *Session) bind(capability string, op talk.Operation) talk.Operation {
	mode := op.Mode
	ask := func(c *talk.Call, args []talk.Value) (fields, error) {
		if s.waiting == nil {
			return nil, errors.New("an Operation ran outside a worker call")
		}
		encoded, err := encodeValues(args)
		if err != nil {
			return nil, err
		}
		now, err := instantText(c.Now())
		if err != nil {
			return nil, err
		}
		need := map[string]any{"m": "op", "call": string(c.ID()), "script": c.ScriptName(), "run": string(c.RunID()), "segment": c.SegmentID(), "grant": c.GrantName(), "capability": capability, "operation": op.Name, "mode": modeNames[mode], "now": now, "args": encoded, "automatic": c.Automatic()}
		optional(need, "scope", c.ScopeName())
		if !c.Automatic() {
			if left, ok := messagehooks.FuelLeft(c); ok {
				need["fuelLeft"] = integer(left)
			}
		}
		r := s.ask(need)
		charged, err := r.optionalInt("charged")
		if err != nil {
			return nil, err
		}
		if charged > 0 {
			if err := c.Charge(charged); err != nil {
				return nil, err
			}
		}
		return r, nil
	}
	// failure reads the results every mode shares: fail, limit and hostError.
	failure := func(r fields) (error, bool) {
		switch {
		case r.has("fail"):
			e, err := r.scriptError("fail", s.waiting.group)
			if err != nil {
				return err, true
			}
			return e, true
		case r.has("limit"):
			return talk.ErrLimit, true
		case r.has("hostError"):
			var detail string
			if err := r.decode("hostError", &detail); err != nil {
				return err, true
			}
			return errors.New(detail), true
		}
		return nil, false
	}
	switch mode {
	case talk.Immediate:
		op.Do = func(c *talk.Call, args []talk.Value) (talk.Value, error) {
			r, err := ask(c, args)
			if err != nil {
				return talk.Nothing, err
			}
			if err, failed := failure(r); failed {
				return talk.Nothing, err
			}
			if !r.has("result") {
				return talk.Nothing, errors.New("op-result for an immediate Operation has no result")
			}
			return r.value("result", s.waiting.group)
		}
	case talk.Suspending:
		op.Start = func(c *talk.Call, args []talk.Value) error {
			r, err := ask(c, args)
			if err != nil {
				return err
			}
			if err, failed := failure(r); failed {
				return err
			}
			if !r.has("started") {
				return errors.New("op-result for a suspending Operation isn't started")
			}
			s.groups[c.Group().Name()].calls[c.ID()] = c
			return nil
		}
	case talk.FireAndForget:
		op.Fire = func(c *talk.Call, args []talk.Value) error {
			r, err := ask(c, args)
			if err != nil {
				return err
			}
			if err, failed := failure(r); failed {
				return err
			}
			if !r.has("done") {
				return errors.New("op-result for a fire-and-forget Operation isn't done")
			}
			return nil
		}
	}
	return op
}

func (s *Session) standardCapability(f fields) (map[string]any, error) {
	name, err := f.str("name")
	if err != nil {
		return nil, err
	}
	var decls map[string]costDecl
	if f.has("costs") {
		if err := f.decode("costs", &decls); err != nil {
			return nil, err
		}
	}
	costs := talk.Costs{}
	for op, c := range decls {
		costs[op] = talk.Cost{Fuel: c.Fuel, Alloc: c.Alloc}
	}
	if name != "clock" {
		return nil, protocolErrorf("Standard Capability %q isn't carried by this Message Layer yet", name)
	}
	def, err := s.core.ClockCapability(costs)
	if err != nil {
		return nil, err
	}
	s.caps[name] = def
	return nil, nil
}

func (s *Session) add(f fields) (map[string]any, error) {
	a, err := f.value("a", nil)
	if err != nil {
		return nil, err
	}
	b, err := f.value("b", nil)
	if err != nil {
		return nil, err
	}
	v, err := talk.Add(a, b)
	var script *talk.ScriptError
	if errors.As(err, &script) {
		form, err := scriptErrorForm(script)
		return map[string]any{"fail": form}, err
	}
	if err != nil {
		return nil, err
	}
	encoded, err := encodeValue(v)
	return map[string]any{"value": encoded}, err
}

type propDecl struct {
	Name     string          `json:"name"`
	Shape    json.RawMessage `json:"shape"`
	ReadOnly bool            `json:"readOnly"`
	GetCost  costDecl        `json:"getCost"`
	SetCost  costDecl        `json:"setCost"`
}

func (s *Session) defineObjectKind(f fields) (map[string]any, error) {
	name, err := f.str("name")
	if err != nil {
		return nil, err
	}
	var props []propDecl
	var parents []string
	if f.has("props") {
		if err := f.decode("props", &props); err != nil {
			return nil, err
		}
	}
	if f.has("parentKinds") {
		if err := f.decode("parentKinds", &parents); err != nil {
			return nil, err
		}
	}
	def := talk.ObjectKindDef{Name: name, ParentKinds: parents}
	for _, p := range props {
		sh, err := shape(p.Shape)
		if err != nil {
			return nil, err
		}
		prop := talk.Prop{Name: p.Name, Shape: sh, GetCost: talk.Cost{Fuel: p.GetCost.Fuel, Alloc: p.GetCost.Alloc}, SetCost: talk.Cost{Fuel: p.SetCost.Fuel, Alloc: p.SetCost.Alloc}}
		prop.Get = func(o *talk.Object) (talk.Value, error) {
			r, err := s.askProp(o, p.Name, nil)
			if err != nil {
				return talk.Nothing, err
			}
			if !r.has("value") {
				return talk.Nothing, errors.New("prop-result for a get has no value")
			}
			return r.value("value", s.waiting.group)
		}
		if !p.ReadOnly {
			prop.Set = func(o *talk.Object, v talk.Value) error {
				_, err := s.askProp(o, p.Name, &v)
				return err
			}
		}
		def.Props = append(def.Props, prop)
	}
	kind, err := s.core.DefineObjectKind(def)
	if err != nil {
		return nil, err
	}
	s.kinds[name] = kind
	return nil, nil
}

// askProp sends a `prop` request; set is nil for a get. It returns the
// result, or the Host's failure as an error.
func (s *Session) askProp(o *talk.Object, prop string, set *talk.Value) (fields, error) {
	if s.waiting == nil {
		return nil, errors.New("a property ran outside a worker call")
	}
	need := map[string]any{"m": "prop", "object": []string{s.kindName(o.Kind()), o.ID()}, "prop": prop}
	if set != nil {
		v, err := encodeValue(*set)
		if err != nil {
			return nil, err
		}
		need["value"] = v
	}
	r := s.ask(need)
	switch {
	case r.has("fail"):
		e, err := r.scriptError("fail", s.waiting.group)
		if err != nil {
			return nil, err
		}
		return nil, e
	case r.has("hostError"):
		var detail string
		if err := r.decode("hostError", &detail); err != nil {
			return nil, err
		}
		return nil, errors.New(detail)
	case set != nil && !r.has("ok"):
		return nil, errors.New("prop-result for a set isn't ok")
	}
	return r, nil
}

func (s *Session) kindName(k *talk.ObjectKind) string {
	for name, kind := range s.kinds {
		if kind == k {
			return name
		}
	}
	return ""
}

func (s *Session) grant(f fields) (map[string]any, error) {
	name, err := f.str("capability")
	if err != nil {
		return nil, err
	}
	def := s.caps[name]
	if def == nil {
		return nil, protocolErrorf("no Capability %q", name)
	}
	if f.has("coordinator") {
		return nil, protocolErrorf("Segment Coordinators aren't carried by this Message Layer yet")
	}
	handle := int64(len(s.grants) + 1)
	var all string
	if json.Unmarshal(f["ops"], &all) == nil && all == "all" {
		g := def.GrantAll(handle)
		if g == nil {
			return nil, &talk.HostError{Code: talk.InvalidValue, Detail: "the binding has no Segment Coordinator"}
		}
		s.grants[handle] = g
		return map[string]any{"grant": handle}, nil
	}
	var ops []string
	if err := f.decode("ops", &ops); err != nil {
		return nil, err
	}
	g, err := def.Grant(ops, handle)
	if err != nil {
		return nil, err
	}
	s.grants[handle] = g
	return map[string]any{"grant": handle}, nil
}

func (s *Session) newGroup(f fields) (map[string]any, error) {
	name, err := f.str("name")
	if err != nil {
		return nil, err
	}
	if s.groups[name] != nil {
		return nil, protocolErrorf("Group %q already exists", name)
	}
	trace, err := f.bool("trace")
	if err != nil {
		return nil, err
	}
	g := &group{calls: map[talk.CallID]*talk.Call{}, requests: map[talk.DeliveryID]request{}}
	o := talk.GroupOptions{Name: name}
	if trace {
		g.trace = &traceBuffer{}
		o.Trace = g.trace
	}
	g.g = s.core.NewGroup(o)
	s.groups[name] = g
	return nil, nil
}

func (s *Session) load(f fields) (map[string]any, error) {
	g, err := s.group(f)
	if err != nil {
		return nil, err
	}
	o := talk.LoadOptions{Grants: map[string]*talk.Grant{}, Objects: map[string]*talk.Object{}}
	if o.Name, err = f.str("name"); err != nil {
		return nil, err
	}
	if o.Source, err = f.str("source"); err != nil {
		return nil, err
	}
	if o.GrantsAsUsed, err = f.bool("grantsAsUsed"); err != nil {
		return nil, err
	}
	var grants map[string]int64
	if f.has("grants") {
		if err := f.decode("grants", &grants); err != nil {
			return nil, err
		}
	}
	for name, handle := range grants {
		grant := s.grants[handle]
		if grant == nil {
			return nil, protocolErrorf("no Grant handle %d", handle)
		}
		o.Grants[name] = grant
	}
	if f.has("owner") {
		if o.Owner, err = f.object("owner", g); err != nil {
			return nil, err
		}
	}
	var objects map[string][]string
	if f.has("objects") {
		if err := f.decode("objects", &objects); err != nil {
			return nil, err
		}
	}
	for name, pair := range objects {
		if o.Objects[name], err = g.object("objects", pair); err != nil {
			return nil, err
		}
	}
	var limits limitsDecl
	if f.has("limits") {
		if err := f.decode("limits", &limits); err != nil {
			return nil, err
		}
	}
	o.Limits = limits.limits()
	script, err := g.g.Load(o)
	if err != nil {
		return nil, err
	}
	return map[string]any{"script": script.Name()}, nil
}

func (s *Session) object(f fields) (map[string]any, error) {
	g, err := s.group(f)
	if err != nil {
		return nil, err
	}
	name, err := f.str("kind")
	if err != nil {
		return nil, err
	}
	kind := s.kinds[name]
	if kind == nil {
		return nil, protocolErrorf("no Object Kind %q", name)
	}
	id, err := f.str("id")
	if err != nil {
		return nil, err
	}
	_, err = g.g.Object(kind, id, nil)
	return nil, err
}

func (s *Session) setParent(f fields) (map[string]any, error) {
	g, err := s.group(f)
	if err != nil {
		return nil, err
	}
	o, err := f.object("object", g)
	if err != nil {
		return nil, err
	}
	parent, err := f.object("parent", g)
	if err != nil {
		return nil, err
	}
	return nil, g.g.SetParent(o, parent)
}

func (s *Session) dispose(f fields) (map[string]any, error) {
	g, err := s.group(f)
	if err != nil {
		return nil, err
	}
	o, err := f.object("object", g)
	if err != nil {
		return nil, err
	}
	return nil, g.g.Dispose(o)
}

// target reads `to`: {object} or {script}.
func (s *Session) target(f fields, g *group) (*talk.Object, *talk.Script, error) {
	to, err := f.sub("to")
	if err != nil {
		return nil, nil, err
	}
	if to.has("object") {
		o, err := to.object("object", g)
		return o, nil, err
	}
	name, err := to.str("script")
	if err != nil {
		return nil, nil, protocolErrorf("`to` names neither an object nor a script")
	}
	script := g.g.Script(name)
	if script == nil {
		return nil, nil, protocolErrorf("no Script %q in Group %s", name, g.g.Name())
	}
	return nil, script, nil
}

func (s *Session) deliver(f fields) (map[string]any, error) {
	g, err := s.group(f)
	if err != nil {
		return nil, err
	}
	o, script, err := s.target(f, g)
	if err != nil {
		return nil, err
	}
	m, err := f.message("message", g)
	if err != nil {
		return nil, err
	}
	var id talk.DeliveryID
	if o != nil {
		id, err = g.g.Deliver(o, m)
	} else {
		id, err = script.Deliver(m)
	}
	if err != nil {
		return nil, err
	}
	return map[string]any{"delivery": string(id)}, nil
}

// request admits a Request. Its result reaches the Host in the run end
// report, so the future stays on the Core's side of the boundary.
func (s *Session) request(f fields) (map[string]any, error) {
	g, err := s.group(f)
	if err != nil {
		return nil, err
	}
	o, script, err := s.target(f, g)
	if err != nil {
		return nil, err
	}
	m, err := f.message("message", g)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	var id talk.DeliveryID
	var pending *talk.Pending
	if o != nil {
		id, pending, err = g.g.Request(ctx, o, m)
	} else {
		id, pending, err = script.Request(ctx, m)
	}
	if err != nil {
		cancel()
		return nil, err
	}
	g.requests[id] = request{pending, cancel}
	return map[string]any{"delivery": string(id)}, nil
}

func (s *Session) cancelDelivery(f fields) (map[string]any, error) {
	g, err := s.group(f)
	if err != nil {
		return nil, err
	}
	id, err := f.str("delivery")
	if err != nil {
		return nil, err
	}
	r, found := g.requests[talk.DeliveryID(id)]
	if !found {
		return nil, protocolErrorf("no cancellable delivery %q", id)
	}
	delete(g.requests, talk.DeliveryID(id))
	r.cancel()
	return nil, nil
}

func (s *Session) broadcast(f fields) (map[string]any, error) {
	g, err := s.group(f)
	if err != nil {
		return nil, err
	}
	m, err := f.message("message", g)
	if err != nil {
		return nil, err
	}
	id, err := g.g.Broadcast(m)
	if err != nil {
		return nil, err
	}
	return map[string]any{"broadcast": string(id)}, nil
}

// pendingCall takes the started Call that `call` names, which the Host settles
// once.
func (s *Session) pendingCall(f fields) (*group, *talk.Call, error) {
	g, err := s.group(f)
	if err != nil {
		return nil, nil, err
	}
	id, err := f.str("call")
	if err != nil {
		return nil, nil, err
	}
	c := g.calls[talk.CallID(id)]
	if c == nil {
		return nil, nil, protocolErrorf("no pending call %q", id)
	}
	return g, c, nil
}

func (s *Session) answer(f fields) (map[string]any, error) {
	g, c, err := s.pendingCall(f)
	if err != nil {
		return nil, err
	}
	v, err := f.value("value", g)
	if err != nil {
		return nil, err
	}
	fuel, err := f.optionalInt("fuel")
	if err != nil {
		return nil, err
	}
	c.AnswerWithCost(v, fuel)
	delete(g.calls, c.ID())
	return nil, nil
}

func (s *Session) fail(f fields) (map[string]any, error) {
	g, c, err := s.pendingCall(f)
	if err != nil {
		return nil, err
	}
	e, err := f.scriptError("error", g)
	if err != nil {
		return nil, err
	}
	c.Fail(e)
	delete(g.calls, c.ID())
	return nil, nil
}

var states = map[talk.GroupState]string{talk.Idle: "idle", talk.Sliced: "sliced", talk.Stopped: "stopped", talk.Rewound: "rewound"}

// pump runs the Group's Pump on its own goroutine, so that each Operation or
// property it reaches can hand a need back to the Host.
func (s *Session) pump(ref int64, f fields) []byte {
	g, err := s.group(f)
	if err != nil {
		return replyFrame(ref, nil, err)
	}
	now, err := f.instant("now")
	if err != nil {
		return replyFrame(ref, nil, err)
	}
	var o talk.PumpOptions
	if o.FuelSlice, err = f.optionalInt("fuelSlice"); err != nil {
		return replyFrame(ref, nil, err)
	}
	if o.FuelCap, err = f.optionalInt("fuelCap"); err != nil {
		return replyFrame(ref, nil, err)
	}
	x := &exchange{ref: ref, group: g, out: make(chan outFrame), results: make(chan fields)}
	s.waiting = x
	go func() {
		ok, err := s.runPump(g, now, o)
		x.out <- outFrame{frame: replyFrame(ref, ok, err), final: true}
	}()
	return s.await(x)
}

func (s *Session) runPump(g *group, now time.Time, o talk.PumpOptions) (ok map[string]any, err error) {
	defer func() {
		if r := recover(); r != nil {
			ok, err = nil, recovered(r)
		}
	}()
	result, err := g.g.Pump(now, o)
	g.settled()
	if err != nil {
		return nil, err
	}
	reports, err := reportForms(result.Reports)
	if err != nil {
		return nil, err
	}
	ok = map[string]any{"state": states[result.State], "fuelUsed": integer(result.FuelUsed), "reports": reports, "abandoned": g.abandoned()}
	if !result.NextDeadline.IsZero() {
		if ok["nextDeadline"], err = instantText(result.NextDeadline); err != nil {
			return nil, err
		}
	}
	if g.trace != nil {
		ok["trace"] = g.trace.take()
	}
	return ok, nil
}

// abandoned forgets the started calls the Core has abandoned, and names them
// so the Host can drop their answers from its outbox.
func (g *group) abandoned() []string {
	out := []string{}
	for id, c := range g.calls {
		if c.Context().Err() != nil {
			out = append(out, string(id))
			delete(g.calls, id)
		}
	}
	slices.Sort(out)
	return out
}

// settled forgets the Requests whose Runs have ended.
func (g *group) settled() {
	for id, r := range g.requests {
		select {
		case <-r.pending.Done():
			r.cancel()
			delete(g.requests, id)
		default:
		}
	}
}

func (s *Session) save(f fields) (map[string]any, error) {
	g, err := s.group(f)
	if err != nil {
		return nil, err
	}
	b, err := g.g.Save()
	if err != nil {
		return nil, err
	}
	return map[string]any{"save": bytesForm(b)}, nil
}

func (s *Session) fingerprint(f fields) (map[string]any, error) {
	g, err := s.group(f)
	if err != nil {
		return nil, err
	}
	fp := g.g.Fingerprint()
	return map[string]any{"fingerprint": bytesForm(fp[:])}, nil
}

func (s *Session) counters(f fields) (map[string]any, error) {
	_, script, err := s.script(f)
	if err != nil {
		return nil, err
	}
	c := script.Counters()
	return map[string]any{"fuelTotal": integer(c.FuelTotal), "allocTotal": integer(c.AllocTotal), "runs": integer(c.Runs), "faults": integer(c.Faults), "persistentState": integer(c.PersistentState), "mailboxLen": c.MailboxLen}, nil
}

func (s *Session) scriptGrants(f fields) (map[string]any, error) {
	_, script, err := s.script(f)
	if err != nil {
		return nil, err
	}
	out := map[string]any{}
	for name, ops := range script.Grants() {
		out[name] = ops
	}
	return out, nil
}
