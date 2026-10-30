package northtalk

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"runtime"
	"slices"
	"strconv"
	"sync"
	"time"
	"unicode/utf8"
	"weak"

	"northtalk.org/go/internal/generated"
	"northtalk.org/go/internal/zigwasm"
)

var zigCompiled struct {
	once     sync.Once
	engine   *zigwasm.Engine
	versions Versions
	err      error
}

func zigEngine() *zigwasm.Engine {
	zigCompiled.once.Do(func() {
		ctx := context.Background()
		engine, err := zigwasm.NewEngine(ctx)
		if err != nil {
			zigCompiled.err = err
			return
		}
		reactor, err := engine.Instantiate(ctx)
		if err != nil {
			engine.Close(ctx)
			zigCompiled.err = err
			return
		}
		defer reactor.Close(ctx)
		data, err := reactor.Frame(ctx, []byte(`{"m":"hello","ref":1,"protocol":1}`))
		if err == nil {
			reply, readErr := (zigReplyReader{}).read(data, 1, "hello")
			err = readErr
			if err == nil {
				err = reply.failure
			}
			if err == nil {
				err = zigDecode(reply.body, reflect.ValueOf(&zigCompiled.versions).Elem())
			}
		}
		if err == nil && (zigCompiled.versions.Language != generated.Version.Language || zigCompiled.versions.CostModel != fmt.Sprint(generated.Costs.Version) || zigCompiled.versions.Unicode != generated.UnicodeVersion) {
			err = fmt.Errorf("embedded Zig artifact does not match Go data-model versions")
		}
		if err == nil {
			// The guest reports zig/0.0.0; the artifact knows its release.
			var recorded zigwasm.Artifact
			recorded, err = zigwasm.Recorded()
			zigCompiled.versions.Core = "zig/" + recorded.Reactor
		}
		if err != nil {
			engine.Close(ctx)
			zigCompiled.err = err
			return
		}
		zigCompiled.engine = engine
	})
	if zigCompiled.err != nil {
		panic(zigCompiled.err)
	}
	return zigCompiled.engine
}

type zigGroup struct {
	group   *Group
	reactor *zigwasm.Reactor
	// Serializes exports, receipt bookkeeping and refs. The Group worker guard
	// owns the entire conversation, including pauses while Host code runs.
	// Inline admission leaves the export on its original guest stack.
	frameMu       sync.Mutex
	exporting     bool
	exportMethod  string
	admissions    []*zigAdmission
	inlineRequest *zigAdmission
	inlineError   error
	inlineWait    []<-chan struct{}
	inlineWake    chan struct{}
	ref           int64
	pendingMu     sync.Mutex
	pending       map[DeliveryID]*Pending
	decisions     map[string]*Deciding
	// Property crossings' Host details, in crossing order, for this Pump.
	propertyDetails []string
	// The guest's Session-scoped registrations, shared with every Group on it.
	reg            *zigRegistry
	runs           map[RunID]DeliveryID
	coordinators   map[*SegmentLifecycle]string
	effectDetails  map[string]string
	callsMu        sync.Mutex
	calls          map[CallID]context.CancelFunc
	failureDetails map[CallID]string
	// The last need's clock reading, as sent and as parsed.
	replyClock     zigReplyClock
	restoreOptions *RestoreOptions
	restoredCalls  map[CallID]*Call
	paused         bool
	// The guest this Group shares with others of its Core, if any, and the
	// Group's handle on it.
	shared *zigShared
	handle string
	// Settlements queued for the next settle-pump (#1320), and how many
	// inputs are sending the queue ahead of themselves.
	// Each queued charge request's future, until a Pump reports it.
	chargesMu     sync.Mutex
	charges       map[ChargeRequestID]*ChargeRequest
	settlementsMu sync.Mutex
	settlements   []zigSettlement
	flushing      int
	// Guest state exists; accessed by the export owner.
	created bool
	// Whether the Group has had nothing but its name, so it may move guest.
	untouched bool
	dropping  runtime.Cleanup
}

// zigFeatures are the guest protocol features the adapter requests and requires.
var zigFeatures = []any{"paused-inputs-v1", "abandoned-before-needs-v1", "crossing-trace-v1", "climb-v1", "function-gone-v1", "function-metadata-v1", "core-message-v1", "standard-refinements-v1", "inline-inputs-v1", "restore-bindings-v1", "group-exchanges-v1", "queued-inputs-v1", "chunked-wasi-v1"}

// zigOptionalFeatures are used when the guest offers them: Object Collection
// declarations need object-elements-v1 (#1143); binary Load needs load-fields-v1.
var zigOptionalFeatures = []any{"object-elements-v1", "load-fields-v1"}

func newZigGroup(g *Group) groupBackend { return newZigSharedGroup(g) }

// A restore needs an initialized Core without an existing Group handle, so
// a restored Group has a guest of its own.
func newZigBackend(g *Group) *zigGroup {
	b := &zigGroup{group: g, inlineWake: make(chan struct{}, 1), pending: map[DeliveryID]*Pending{}, decisions: map[string]*Deciding{}, reg: newZigRegistry(), runs: map[RunID]DeliveryID{}, coordinators: map[*SegmentLifecycle]string{}, effectDetails: map[string]string{}, calls: map[CallID]context.CancelFunc{}, failureDetails: map[CallID]string{}}
	owner := weak.Make(b)
	reactor, err := zigEngine().InstantiateObserved(context.Background(), func(event []byte) ([]byte, error) {
		live := owner.Value()
		if live == nil {
			return nil, fmt.Errorf("inline event after Group collection")
		}
		return live.inlineEvent(event)
	})
	if err != nil {
		panic(err)
	}
	b.reactor = reactor
	err = b.checkHello()
	if err != nil {
		reactor.Close(context.Background())
		panic(err)
	}
	// The cleanup argument owns only the guest module, never the Group or its
	// callbacks. Group/Script/future references keep the Group alive normally.
	runtime.AddCleanup(g, func(r *zigwasm.Reactor) { r.Close(context.Background()) }, reactor)
	return b
}

// exchange reserves the worker ref across every need/result. Inputs use their
// own refs. Host callbacks use the admission queue without acquiring guest
// ownership or holding adapter admission/registry locks.
func (b *zigGroup) send(m string, fields map[string]any) (zigReply, error) {
	return b.exchange(m, fields, nil)
}

func (b *zigGroup) exchange(m string, fields map[string]any, receipt func(zigReply) error) (zigReply, error) {
	reply, err := b.exchangeDecoded(m, fields, okReceipt(receipt))
	return reply.body, err
}

func (b *zigGroup) exchangeDecoded(m string, fields map[string]any, receipt zigReceipt) (zigResponse, error) {
	reply, err := b.exchangeFrame(m, fields, nil, receipt)
	if err == nil {
		err = reply.failure
	}
	return reply, err
}

// exchangeFrame sends the first frame and answers decoded needs until a final
// reply. Refusals stay in the reply so combined receipts retain admission.
func (b *zigGroup) exchangeFrame(m string, fields map[string]any, first *zbFrame, receipt zigReceipt) (zigResponse, error) {
	defer runtime.KeepAlive(b)
	// Queued settlements go first, unless this frame carries them or is
	// one of them.
	if b.reg.settlements && m != "answer" && m != "fail" && (first == nil || first.trailer == nil) {
		if err := b.flushSettlements(); err != nil {
			return zigResponse{}, err
		}
	}
	var ref int64
	for {
		b.frameMu.Lock()
		if ref == 0 {
			b.ref++
			ref = b.ref
		}
		fields["m"], fields["ref"], fields["group"] = m, ref, b.groupHandle()
		if m != "new-group" && m != "define-object-kind" {
			b.untouched = false
		}
		b.frameMu.Unlock()
		packet, err := b.export(zigOut{fields: fields, bin: first}, receipt)
		first = nil
		if err != nil {
			return zigResponse{}, err
		}
		if packet.need == nil {
			return packet, nil
		}
		fields, first, err = b.callback(packet.need)
		if err != nil {
			return zigResponse{}, err
		}
		m = packet.need.kind + "-result"
	}
}

// observe publishes every reply outside the export lock, including refused
// reentrant worker calls which can carry earlier buffered Trace records.
func (b *zigGroup) observe(reply zigResponse) {
	b.abandonedIDs(reply.abandoned)
	b.settledIDs(reply.settled)
	for _, line := range reply.trace {
		b.group.emit(line)
	}
}

// zigFrameSeen, set by tests, sees each frame an export sends.
var zigFrameSeen func([]byte)

// frame is called only by the export owner; replies own Go memory.
func (b *zigGroup) frame(out zigOut) (zigResponse, error) {
	fields := out.fields
	method := fields["m"].(string)
	// Session declarations do not require a Group. Every other first frame
	// creates it, with Load folding creation into its own binary envelope.
	firstGroup := b.shared != nil && !b.created && method != "new-group" && method != "hello" && method != "define-object-kind" && method != "define-capability" && method != "grant"
	if firstGroup && !(method == "load" && b.reg.load) {
		init := b.groupFields()
		init["m"], init["ref"], init["group"] = "new-group", fields["ref"], b.handle
		reply, err := b.frame(zigOut{fields: init})
		if err != nil {
			return zigResponse{}, err
		}
		if reply.failure != nil {
			return reply, nil
		}
		b.createdGroup()
	}
	var data []byte
	var err error
	if method == "load" && b.reg.load {
		if firstGroup {
			fields["newGroup"] = b.groupFields()
		}
		data, err = zbLoad(fields)
		if err != nil {
			return zigResponse{}, err
		}
		if firstGroup {
			b.createdGroup()
		}
	} else if out.bin != nil {
		data = out.bin.bytes(fields["ref"].(int64))
	} else if data, err = zigJSON(nil, fields); err != nil {
		return zigResponse{}, err
	}
	if zigFrameSeen != nil {
		zigFrameSeen(data)
	}
	if b.shared != nil {
		data, err = b.shareFrame(data)
	} else {
		data, err = b.reactor.Frame(context.Background(), data)
	}
	if err != nil {
		return zigResponse{}, err
	}
	reply, err := b.replyReader().read(data, fields["ref"].(int64), fields["m"].(string))
	if err != nil {
		return zigResponse{}, err
	}
	b.frameMu.Lock()
	reply.updatePause(&b.paused)
	b.frameMu.Unlock()
	return reply, nil
}
func (b *zigGroup) replyReader() zigReplyReader {
	return zigReplyReader{resolver: b, clock: &b.replyClock}
}

// A rejected worker never starts a second conversation. While paused, ask the
// transport to record the refusal in the current crossing's Trace order.
func (b *zigGroup) beginWorker(m string, fields map[string]any) error {
	return b.beginWorkerWith(m, func() map[string]any { return fields })
}

// beginWorkerWith builds the refusal's fields only when it is refused.
func (b *zigGroup) beginWorkerWith(m string, makeFields func() map[string]any) error {
	err := b.group.beginWorker()
	if err == nil {
		return nil
	}
	b.frameMu.Lock()
	active := b.paused || b.exporting
	b.frameMu.Unlock()
	if active {
		// The export may finish before this queued refusal is serviced.
		// It must still never turn into a second guest worker.
		fields := makeFields()
		fields["refuseWorker"] = true
		if _, frameErr := b.send(m, fields); frameErr != nil {
			err = frameErr
		}
	}
	return err
}

func (b *zigGroup) load(o LoadOptions) (*Script, error) {
	if err := b.beginWorker("load", map[string]any{"name": o.Name, "source": o.Source}); err != nil {
		return nil, err
	}
	defer b.group.endWorker()
	if err := b.syncKinds(); err != nil {
		return nil, err
	}
	grants, kept, err := b.grants(o.Grants)
	if err != nil {
		return nil, err
	}
	fields := map[string]any{"name": o.Name, "source": o.Source, "grants": grants, "grantsAsUsed": o.GrantsAsUsed}
	// The guest refuses another Group's handle, named by a placeholder it
	// never made, as wrong group with this Load's records.
	handle := func(h *Object) map[string]any {
		if h == nil || h.group != b.group {
			return map[string]any{"$object": []any{"", ""}}
		}
		return zigObject(h)
	}
	if o.Owner != nil {
		fields["owner"] = handle(o.Owner)
	}
	if len(o.Objects) > 0 {
		bound := map[string]any{}
		for name, h := range o.Objects {
			bound[name] = handle(h)
		}
		fields["objects"] = bound
	}
	limits, err := zigLimits(o.Limits)
	if err != nil {
		return nil, err
	}
	fields["limits"] = limits
	var s *Script
	_, err = b.exchange("load", fields, func(zigReply) error {
		s = &Script{group: b.group, name: o.Name, source: o.Source, limits: o.Limits, grants: kept, owner: o.Owner}
		b.group.mu.Lock()
		b.group.scripts = append(b.group.scripts, s)
		b.group.mu.Unlock()
		return nil
	})
	if err != nil {
		return nil, err
	}
	return s, nil
}

func (b *zigGroup) queue(s *Script, to *Object, fn *Value, m Message, ctx context.Context, how string, d *Deciding) (DeliveryID, *Pending, error) {
	if b.reg.binary && (fn != nil || how == "request") {
		return b.queueBinary(s, to, fn, m, ctx, true)
	}
	if b.reg.queue {
		return b.queueFieldsBinary(s, to, m, ctx, how, d)
	}
	method, fields, how, err := b.queueFields(s, to, fn, m, how)
	if err != nil {
		return "", nil, err
	}
	// Register the future before releasing the receipt lock. Trace/OnReady
	// may enqueue or Pump immediately after that lock is released.
	var id DeliveryID
	var pending *Pending
	reply, err := b.exchangeFrame(method, fields, nil, func(reply zigResponse) error {
		if reply.failure != nil {
			return nil
		}
		id = reply.admission.delivery
		pending = b.admitted(id, how, ctx, d)
		return nil
	})
	if err != nil {
		return "", nil, err
	}
	if err = reply.failure; err != nil {
		return "", nil, err
	}
	b.ready()
	return id, pending, nil
}

// queueFields is a queued input's JSON message and fields, and how its
// future is kept.
func (b *zigGroup) queueFields(s *Script, to *Object, fn *Value, m Message, how string) (string, map[string]any, string, error) {
	message, err := b.zigQueuedMessage(m)
	if err != nil {
		return "", nil, "", err
	}
	fields := map[string]any{"message": message}
	method := how
	switch {
	case fn != nil:
		// A call carries its Function Value, arguments and limits directly.
		encoded, err := b.zigEncoded(*fn)
		if err != nil {
			return "", nil, "", err
		}
		method, how = "call", "request"
		fields = map[string]any{"fn": encoded, "args": message["args"]}
		if limits, ok := message["limits"]; ok {
			fields["limits"] = limits
		}
	case how == "decide-broadcast":
		method = "decide"
		fields["broadcast"] = true
	case how == "broadcast":
	case to != nil:
		fields["to"] = map[string]any{"object": zigObject(to)}
	default:
		fields["to"] = map[string]any{"script": s.name}
	}
	return method, fields, how, nil
}

func (b *zigGroup) zigMessage(m Message) (map[string]any, error) {
	args := make([]any, len(m.Args))
	for i, v := range m.Args {
		encoded, err := b.zigEncoded(v)
		if err != nil {
			return nil, err
		}
		args[i] = encoded
	}
	message := map[string]any{"name": m.Name, "args": args}
	if m.Limits != nil {
		limits, err := zigOverride(*m.Limits)
		if err != nil {
			return nil, err
		}
		message["limits"] = limits
	}
	return message, nil
}

// Presence bits and sub-millisecond durations cannot be represented by the
// wire override. Send an invalid sentinel through the guest so its refusal
// keeps callback Trace ordering and does not consume an id.
func (b *zigGroup) zigQueuedMessage(m Message) (map[string]any, error) {
	wire := m
	wire.Limits = nil
	message, err := b.zigMessage(wire)
	if err != nil {
		return nil, err
	}
	if m.Limits != nil {
		limits, err := zigOverride(*m.Limits)
		if err != nil {
			message["limits"] = []any{}
		} else {
			message["limits"] = limits
		}
	}
	return message, nil
}

func (b *zigGroup) ready() {
	if b.group.options.OnReady != nil {
		b.group.options.OnReady()
	}
}

func (b *zigGroup) cancelDelivery(id DeliveryID) {
	if _, err := b.send("cancel-delivery", map[string]any{"delivery": string(id)}); err != nil {
		panic(err)
	}
	b.ready()
}

// queued serves the Session's private queue hook from the owning Core.
func (b *zigGroup) queued() bool {
	reply, err := b.send("queued-inputs", map[string]any{})
	if err != nil {
		panic(err)
	}
	queued, ok := reply.get("queued").boolean()
	if !ok {
		panic(fmt.Errorf("talk: queued-inputs reply lacks a boolean queued"))
	}
	return queued
}

func (b *zigGroup) pump(now time.Time, options PumpOptions) (PumpResult, error) {
	if err := b.beginWorkerWith("pump", func() map[string]any { return zigPumpFields(now, options) }); err != nil {
		return PumpResult{}, err
	}
	defer b.group.endWorker()
	// Refused Clocks cannot be encoded as guest Instants. Record the Host input
	// here, before taking queued inputs or entering the guest.
	clock := now.Round(0).UTC().Truncate(time.Microsecond)
	if clock.Year() < 1 || clock.Year() > 9999 {
		traceFields := map[string]string{"clock": clock.Format(time.RFC3339Nano)}
		if options.FuelSlice > 0 {
			traceFields["fuel-slice"] = strconv.FormatInt(options.FuelSlice, 10)
		}
		if options.FuelCap > 0 {
			traceFields["fuel-cap"] = strconv.FormatInt(options.FuelCap, 10)
		}
		b.group.recordRefusal("pump", nil, traceFields, InvalidValue)
		return PumpResult{}, &HostError{InvalidValue, "Clock outside year 1–9999"}
	}
	if err := b.syncKinds(); err != nil {
		return PumpResult{}, err
	}
	if b.reg.binary {
		return b.pumpBinary(now, options)
	}
	var result PumpResult
	reply, err := b.exchangeFrame("pump", zigPumpFields(now, options), nil, func(reply zigResponse) error {
		if reply.failure != nil {
			return nil
		}
		var err error
		result, err = b.completePump(reply.completion)
		clear(b.restoredCalls)
		return err
	})
	if err == nil {
		err = reply.failure
	}
	return result, err
}
func (b *zigGroup) completePump(c zigCompletion) (PumpResult, error) {
	if c.err != nil {
		return c.result, c.err
	}
	return b.finishPump(c.result, c.climbed, c.gone)
}

// finishPump completes Host-only Report details and settles the futures a
// Pump's Reports and stale Function Value calls end, from either encoding.
func (b *zigGroup) finishPump(result PumpResult, climbed []Report, gone []string) (PumpResult, error) {
	for _, report := range result.Reports {
		if effect, ok := report.(*EffectFailure); ok {
			effect.Detail = b.effectDetail(effect)
		}
		if end, ok := report.(*RunEnd); ok && end.Effect != nil {
			end.Effect.Detail = b.effectDetail(end.Effect)
		}
		if failed, ok := report.(*CallFailed); ok && failed.Call == "" {
			// A property failure: the next unconsumed property detail.
			if len(b.propertyDetails) > 0 {
				failed.Detail, b.propertyDetails = b.propertyDetails[0], b.propertyDetails[1:]
			}
		} else if ok {
			failed.Detail = b.failureDetails[failed.Call]
			// Shape, catalogue and malformed-Data checks run in Zig after landing.
			// There is no Go callback error to retain for these failures.
			if failed.Detail == "" {
				failed.Detail = "Host result rejected by the Core"
			}
			if name, ok := b.reg.definitionName(failed.Operation.Capability); ok {
				failed.Operation.Capability = name
			}
		}
	}
	clear(b.failureDetails)
	clear(b.effectDetails)
	b.propertyDetails = nil
	b.pendingMu.Lock()
	defer b.pendingMu.Unlock()
	settle := func(id DeliveryID, value Value, failure *ScriptError) {
		if p := b.pending[id]; p != nil {
			delete(b.pending, id)
			p.settle(value, failure)
		}
	}
	// A stale Function Value call ends with no report.
	for _, id := range gone {
		settle(DeliveryID(id), Nothing, sendFailure("function gone", nil))
	}
	b.chargesMu.Lock()
	for _, report := range result.Reports {
		if r, ok := report.(*ChargeResult); ok {
			if q := b.charges[r.Request]; q != nil {
				delete(b.charges, r.Request)
				q.result = r
				close(q.done)
			}
		}
	}
	b.chargesMu.Unlock()
	unhandled := map[DeliveryID]bool{}
	for _, report := range result.Reports {
		if r, ok := report.(*Unhandled); ok {
			unhandled[r.Delivery] = true
		}
	}
	for _, report := range result.Reports {
		switch r := report.(type) {
		case *RunStarted:
			b.runs[r.Run] = r.Delivery
		case *RunEnd:
			delete(b.runs, r.Run)
			if slices.Contains(climbed, Report(r)) {
				continue
			}
			if unhandled[r.Delivery] {
				settle(r.Delivery, Nothing, sendFailure("unhandled", nil))
			} else if r.Outcome == Completed {
				settle(r.Delivery, r.Result, nil)
			} else {
				reason := map[Outcome]string{Errored: "errored", LimitFault: "limit fault", Cancelled: "cancelled", UnhandledOutcome: "unhandled", Dropped: "dropped", EffectFailureOutcome: "effect failed"}[r.Outcome]
				settle(r.Delivery, Nothing, sendFailure(reason, r.Error))
			}
		case *RunDiscarded:
			if r.Reason == "rewind" {
				delete(b.runs, r.Run)
			}
		case *Unhandled:
			settle(r.Delivery, Nothing, sendFailure("unhandled", nil))
		case *Decided:
			id := string(r.Delivery)
			if r.Broadcast != "" {
				id = string(r.Broadcast)
			}
			if d := b.decisions[id]; d != nil {
				delete(b.decisions, id)
				d.seal(r)
				d.finish()
			}
		case *Stop:
			for _, id := range r.DroppedMessages {
				settle(id, Nothing, sendFailure("stopped", nil))
			}
			for _, run := range r.DiscardedRuns {
				settle(b.runs[run], Nothing, sendFailure("stopped", nil))
				delete(b.runs, run)
			}
		}
	}
	return result, nil
}

func (b *zigGroup) worker(method string, fields map[string]any) (zigReply, error) {
	if err := b.beginWorker(method, fields); err != nil {
		return nil, err
	}
	defer b.group.endWorker()
	return b.send(method, fields)
}
func (b *zigGroup) inspect() Inspection {
	reply, err := b.worker("inspect", map[string]any{})
	if err != nil {
		panic(err)
	}
	var inspection Inspection
	if err = b.decode(reply, reflect.ValueOf(&inspection).Elem()); err != nil {
		panic(err)
	}
	return inspection
}
func (b *zigGroup) counters(s *Script) Counters {
	reply, err := b.worker("counters", map[string]any{"script": s.name})
	if err != nil {
		panic(err)
	}
	var counters Counters
	if err = zigDecode(reply, reflect.ValueOf(&counters).Elem()); err != nil {
		panic(err)
	}
	return counters
}
func (b *zigGroup) control(s *Script, method string, fields map[string]any) {
	fields["script"] = s.name
	if _, err := b.send(method, fields); err != nil {
		panic(err)
	}
	b.ready()
}

func (b *zigGroup) zigDataOnly(v Value) error {
	stack := []Value{v}
	for len(stack) > 0 {
		v = stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		switch v.Kind() {
		case KindFunction:
			if v.inner.Function() == nil || v.inner.Function().Group != b.group {
				return &HostError{WrongGroup, "Function Value belongs to another Group"}
			}
		case KindObject:
			if o, _ := v.AsObject(); o == nil || o.group != b.group {
				return &HostError{WrongGroup, "Object belongs to another Group"}
			}
		case KindList:
			for i := 1; i <= v.Len(); i++ {
				stack = append(stack, v.Index(i))
			}
		case KindMap:
			for _, entry := range v.Entries() {
				stack = append(stack, entry.Val)
			}
		}
	}
	return nil
}

func zigLimits(l Limits) (map[string]any, error) {
	if l.MaxWait%time.Millisecond != 0 {
		return nil, &HostError{InvalidValue, "MaxWait must be whole milliseconds"}
	}
	return map[string]any{"fuelPerRun": l.FuelPerRun, "allocPerRun": l.AllocPerRun, "persistentState": l.PersistentState, "callDepth": l.CallDepth, "patternSize": l.PatternSize, "mailboxDepth": l.MailboxDepth, "maxWaitMs": l.MaxWait.Milliseconds(), "maxJoin": l.MaxJoin, "cleanupBudget": l.CleanupBudget}, nil
}
func zigOverride(l LimitOverride) (map[string]any, error) {
	if l.Set & ^(OverrideFuelPerRun|OverrideAllocPerRun|OverrideMaxWait|OverrideMaxJoin) != 0 {
		return nil, &HostError{InvalidValue, "unknown limit override field"}
	}

	if l.MaxWait%time.Millisecond != 0 {
		return nil, &HostError{InvalidValue, "MaxWait must be whole milliseconds"}
	}
	out := map[string]any{}
	for _, field := range []struct {
		name  string
		value int64
		flag  LimitOverrideFields
	}{{"fuelPerRun", l.FuelPerRun, OverrideFuelPerRun}, {"allocPerRun", l.AllocPerRun, OverrideAllocPerRun}, {"maxWaitMs", l.MaxWait.Milliseconds(), OverrideMaxWait}, {"maxJoin", int64(l.MaxJoin), OverrideMaxJoin}} {
		if field.value != 0 || l.Set&field.flag != 0 {
			out[field.name] = field.value
		}
	}
	return out, nil
}

// decode resolves Object handles and Function Values in Value Encodings
// against this Group.
func (b *zigGroup) decode(src zigReply, dst reflect.Value) error {
	return zigDecodeResolving(src, dst, b)
}

// Raw Value Encodings are trusted outputs of EncodeValue. Copy them directly:
// encoding/json's RawMessage validation would impose its 10,000-level limit.
func zigJSON(out []byte, v any) ([]byte, error) {
	switch v := v.(type) {
	case json.RawMessage:
		return append(out, v...), nil
	case string:
		if !utf8.ValidString(v) {
			return nil, &HostError{InvalidValue, "invalid UTF-8"}
		}
		if zigPlainString(v) {
			out = append(out, '"')
			out = append(out, v...)
			return append(out, '"'), nil
		}
	case int64:
		return strconv.AppendInt(out, v, 10), nil
	case int:
		return strconv.AppendInt(out, int64(v), 10), nil
	case bool:
		return strconv.AppendBool(out, v), nil
	case nil:
		return append(out, "null"...), nil
	case map[string]any:
		out = append(out, '{')
		var buf [16]string
		keys := buf[:0]
		for key := range v {
			keys = append(keys, key)
		}
		slices.Sort(keys)
		for i, key := range keys {
			var err error
			if i > 0 {
				out = append(out, ',')
			}
			out, err = zigJSON(out, key)
			if err != nil {
				return nil, err
			}
			out = append(out, ':')
			out, err = zigJSON(out, v[key])
			if err != nil {
				return nil, err
			}
		}
		return append(out, '}'), nil
	case []any:
		out = append(out, '[')
		for i, item := range v {
			var err error
			if i > 0 {
				out = append(out, ',')
			}
			out, err = zigJSON(out, item)
			if err != nil {
				return nil, err
			}
		}
		return append(out, ']'), nil
	}
	b, err := json.Marshal(v)
	return append(out, b...), err
}

// zigPlainString reports whether s needs no JSON escape.
func zigPlainString(s string) bool {
	for i := 0; i < len(s); i++ {
		if c := s[i]; c < 0x20 || c == '"' || c == '\\' {
			return false
		}
	}
	return true
}

func (b *zigGroup) groupHandle() string {
	if b.handle == "" {
		return "g"
	}
	return b.handle
}

// checkHello opens the guest's session and checks it offers every feature
// the adapter requires.
func (b *zigGroup) checkHello() error {
	binary, wanted, err := zigRequestPumpFeature()
	if err != nil {
		return err
	}
	callbacks, err := zigCallbacksWanted()
	if err != nil {
		return err
	}
	wantedLoad := true
	wantedQueue := wanted
	features := append(slices.Clone(zigFeatures), zigOptionalFeatures...)
	if wanted {
		features = append(features, binary)
	}
	if callbacks {
		features = append(features, zigCallbacksFeature)
	}
	if wanted {
		features = append(features, zigSettlementsFeature, zigQueueFeature)
	}
	hello, err := b.send("hello", map[string]any{"protocol": 1, "features": features})
	if err != nil {
		// Older guests may support every earlier optional feature but not
		// Load or queue fields. Keep those negotiations when falling back to
		// JSON Load and queued inputs.
		wantedLoad = false
		wantedQueue = false
		features = slices.DeleteFunc(features, func(feature any) bool { return feature == "load-fields-v1" || feature == zigQueueFeature })
		hello, err = b.send("hello", map[string]any{"protocol": 1, "features": features})
	}
	wantedElements := true
	if err != nil {
		// A guest refuses a feature it does not know, leaving its session
		// unchanged, so ask again without the optional ones.
		wanted = false
		wantedLoad = false
		wantedElements = false
		hello, err = b.send("hello", map[string]any{"protocol": 1, "features": zigFeatures})
	}
	if err == nil {
		features := hello.get("features").items()
		for _, offered := range features {
			switch zigText(offered) {
			case "load-fields-v1":
				b.reg.load = wantedLoad
			case "object-elements-v1":
				b.reg.elements = wantedElements
			case binary:
				// Binary frames only after the reply shows the feature.
				b.reg.binary = wanted
			case zigSettlementsFeature:
				b.reg.settlements = wanted
			case zigQueueFeature:
				b.reg.queue = wanted && wantedQueue
			}
		}
		for _, required := range zigFeatures {
			found := false
			for _, offered := range features {
				if zigText(offered) == required {
					found = true
				}
			}
			if !found {
				err = fmt.Errorf("embedded Zig artifact omits %s", required)
				break
			}
		}
	}
	if err == nil {
		err = b.reactor.EnableChunking()
	}
	return err
}
