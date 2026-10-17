//go:build talk_zig_experimental

package northtalk

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
	"weak"

	"github.com/odogono/odgn-talk/impl/go/internal/generated"
	"github.com/odogono/odgn-talk/impl/go/internal/zigwasm"
)

var zigCompiled struct {
	once     sync.Once
	engine   *zigwasm.Engine
	versions Versions
	err      error
}

func init() {
	experimentalGroupFactory = newZigGroup
	experimentalVersions = func() Versions { zigEngine(); return zigCompiled.versions }
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
		var root zigReply
		if err == nil {
			root, err = zigParseReply(data)
		}
		if err == nil {
			err = zigDecode(root.get("ok"), reflect.ValueOf(&zigCompiled.versions).Elem())
		}
		if err == nil && (zigCompiled.versions.Language != generated.Version.Language || zigCompiled.versions.CostModel != fmt.Sprint(generated.Costs.Version) || zigCompiled.versions.Unicode != generated.UnicodeVersion) {
			err = fmt.Errorf("embedded Zig artifact does not match Go data-model versions")
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
	restoreOptions *RestoreOptions
	restoredCalls  map[CallID]*Call
	paused         bool
	// The guest this Group shares with others of its Core, if any, and the
	// Group's handle on it.
	shared *zigShared
	handle string
	// Whether the Group has had nothing but its name, so it may move guest.
	untouched bool
	dropping  runtime.Cleanup
}

// zigFeatures are the guest protocol features the adapter requests and requires.
var zigFeatures = []any{"paused-inputs-v1", "abandoned-before-needs-v1", "crossing-trace-v1", "climb-v1", "function-gone-v1", "function-metadata-v1", "standard-refinements-v1", "inline-inputs-v1", "restore-bindings-v1", "group-exchanges-v1", "queued-inputs-v1"}

// zigOptionalFeatures are used when the guest offers them: Object Collection
// declarations need object-elements-v1 (#1143).
var zigOptionalFeatures = []any{"object-elements-v1"}

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
	defer runtime.KeepAlive(b)
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
		packet, err := b.export(fields, receipt)
		if err != nil {
			return nil, err
		}
		if packet.err.present() {
			return nil, zigFailure(packet.err)
		}
		need := packet.need
		if !need.present() {
			return packet.ok, nil
		}
		fields, err = b.callback(need)
		if err != nil {
			return nil, err
		}
		m = zigText(need.get("m")) + "-result"
	}
}

// observe publishes every reply outside the export lock, including refused
// reentrant worker calls which can carry earlier buffered Trace records.
func (b *zigGroup) observe(packet zigPacket, m string) {
	var ok [3]zigReply
	packet.ok.lookup(zigObservedKeys, ok[:])
	b.abandoned(packet.abandoned)
	b.abandoned(ok[0])
	b.settled(packet.settled)
	b.settled(ok[1])
	for _, line := range packet.trace.items() {
		b.group.emit(zigText(line))
	}
	// Grants is a name-to-Operations map; "trace" is a legal Grant name,
	// and Grant inspection itself produces no Trace records.
	if m != "grants" {
		for _, line := range ok[2].items() {
			b.group.emit(zigText(line))
		}
	}
}

var zigObservedKeys = []string{"abandoned", "settled", "trace"}

// frame is called only by the export owner; replies own Go memory.
func (b *zigGroup) frame(fields map[string]any) (zigPacket, error) {
	data, err := zigJSON(nil, fields)
	if err != nil {
		return zigPacket{}, err
	}
	if b.shared != nil {
		data, err = b.shareFrame(data)
	} else {
		data, err = b.reactor.Frame(context.Background(), data)
	}
	if err != nil {
		return zigPacket{}, err
	}
	root, err := zigParseReply(data)
	if err != nil {
		return zigPacket{}, err
	}
	packet := zigReadPacket(root)
	if !packet.ref.present() {
		return zigPacket{}, fmt.Errorf("Zig reply omitted ref")
	}
	if got, ok := packet.ref.int64(); !ok || got != fields["ref"] {
		return zigPacket{}, fmt.Errorf("Zig reply ref mismatch")
	}
	b.frameMu.Lock()
	defer b.frameMu.Unlock()
	if packet.need.present() {
		b.paused = true
	} else if !packet.err.present() && (fields["m"] == "pump" || fields["m"] == "op-result" || fields["m"] == "trace-result" || fields["m"] == "release-result" || fields["m"] == "resolve-result") {
		b.paused = false
	}
	return packet, nil
}
func zigFailure(failure zigReply) error {
	switch zigText(failure.get("kind")) {
	case "host error":
		return &HostError{Code: HostErrorCode(zigText(failure.get("code"))), Detail: zigText(failure.get("detail"))}
	case "mailbox full":
		return ErrMailboxFull
	case "load error":
		rejected := new(LoadError)
		if err := zigDecode(failure, reflect.ValueOf(rejected).Elem()); err != nil {
			return err
		}
		return rejected
	default:
		return fmt.Errorf("Zig Message Layer: %s", zigText(failure.get("detail")))
	}
}

// A rejected worker never starts a second conversation. While paused, ask the
// transport to record the refusal in the current crossing's Trace order.
func (b *zigGroup) beginWorker(m string, fields map[string]any) error {
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
	message, err := b.zigQueuedMessage(m)
	if err != nil {
		return "", nil, err
	}
	fields := map[string]any{"message": message}
	method := how
	switch {
	case fn != nil:
		// A call carries its Function Value, arguments and limits directly.
		encoded, err := b.zigEncoded(*fn)
		if err != nil {
			return "", nil, err
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
	// Register the future before releasing the receipt lock. Trace/OnReady
	// may enqueue or Pump immediately after that lock is released.
	var id DeliveryID
	var pending *Pending
	_, err = b.exchange(method, fields, func(reply zigReply) error {
		id = DeliveryID(zigText(reply.get("delivery")))
		if strings.HasSuffix(how, "broadcast") {
			id = DeliveryID(zigText(reply.get("broadcast")))
		}
		cancel := func() {
			b.cancelDelivery(id)
		}
		if how == "request" {
			pending = &Pending{done: make(chan struct{})}
			b.pendingMu.Lock()
			b.pending[id] = pending
			b.pendingMu.Unlock()
			if ctx != nil {
				pending.stop = context.AfterFunc(ctx, cancel)
			}
		}
		if d != nil {
			b.pendingMu.Lock()
			b.decisions[string(id)] = d
			b.pendingMu.Unlock()
			if ctx != nil {
				d.stop = context.AfterFunc(ctx, func() {
					// A sealed Verdict ignores its deadline.
					if !d.isSealed() {
						cancel()
					}
				})
			}
		}
		return nil
	})
	if err != nil {
		return "", nil, err
	}
	b.ready()
	return id, pending, nil
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
	var queued bool
	if err := zigDecode(reply.get("queued"), reflect.ValueOf(&queued).Elem()); err != nil {
		panic(err)
	}
	return queued
}

func (b *zigGroup) pump(now time.Time, options PumpOptions) (PumpResult, error) {
	fields := map[string]any{"now": now.Round(0).UTC().Truncate(time.Microsecond).Format(time.RFC3339Nano), "fuelSlice": options.FuelSlice, "fuelCap": options.FuelCap}
	if err := b.beginWorker("pump", fields); err != nil {
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
	var result PumpResult
	_, err := b.exchange("pump", fields, func(reply zigReply) error {
		var err error
		result, err = b.pumpReceipt(reply)
		clear(b.restoredCalls)
		return err
	})

	return result, err
}
func (b *zigGroup) pumpReceipt(reply zigReply) (PumpResult, error) {
	var result PumpResult
	if err := b.decode(reply, reflect.ValueOf(&result).Elem()); err != nil {
		return result, err
	}
	// A Run whose message climbed the Message Path hasn't answered its asker.
	climbed := map[Report]bool{}
	for _, row := range reply.get("reports").items() {
		var report Report
		switch zigText(row.get("kind")) {
		case "run end":
			report = &RunEnd{}
		case "run started":
			report = &RunStarted{}
		case "run discarded":
			report = &RunDiscarded{}
		case "run accounting":
			report = &RunAccounting{}
		case "causal work":
			report = &CausalWork{}
		case "stop":
			report = &Stop{}
		case "unhandled":
			report = &Unhandled{}
		case "host error":
			report = &HostError{}
		case "effect failure":
			report = &EffectFailure{}
		case "call failed":
			report = &CallFailed{}
		case "decided":
			report = &Decided{}
		default:
			return result, backendUnsupported("Report " + zigText(row.get("kind")))
		}
		if err := b.decode(row, reflect.ValueOf(report).Elem()); err != nil {
			return result, err
		}
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
		if c, _ := row.get("climbed").boolean(); c {
			climbed[report] = true
		}
		result.Reports = append(result.Reports, report)
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
	for _, id := range reply.get("gone").items() {
		settle(DeliveryID(zigText(id)), Nothing, sendFailure("function gone", nil))
	}
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
			if climbed[r] {
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

// The envelope is read in place from the reply's bytes. Data payloads are
// decoded once, straight from their own bytes, as Value Encodings, preserving
// tags and decimals.
func zigDecode(src zigReply, dst reflect.Value) error { return zigDecodeResolving(src, dst, nil) }

// decode resolves Object handles and Function Values in Value Encodings
// against this Group.
func (b *zigGroup) decode(src zigReply, dst reflect.Value) error {
	return zigDecodeResolving(src, dst, b)
}

// zigField is one struct field's envelope key.
type zigField struct {
	index     int
	name, key string
	anonymous bool
}

var zigFieldCache sync.Map // reflect.Type -> []zigField

func zigFields(t reflect.Type) []zigField {
	if cached, ok := zigFieldCache.Load(t); ok {
		return cached.([]zigField)
	}
	var fields []zigField
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		if f.Name == "Reports" {
			continue
		}
		key := strings.ToLower(f.Name[:1]) + f.Name[1:]
		if f.Name == "ID" || f.Name == "PC" {
			key = strings.ToLower(f.Name)
		}
		if f.Name == "Function" {
			key = "fn"
		}
		fields = append(fields, zigField{i, f.Name, key, f.Anonymous})
	}
	zigFieldCache.Store(t, fields)
	return fields
}

var (
	zigObjectType      = reflect.TypeFor[*Object]()
	zigValueType       = reflect.TypeFor[Value]()
	zigPairType        = reflect.TypeFor[Pair]()
	zigTimeType        = reflect.TypeFor[time.Time]()
	zigScriptErrorType = reflect.TypeFor[ScriptError]()
)

func zigDecodeResolving(src zigReply, dst reflect.Value, b *zigGroup) error {
	if !src.present() {
		return nil
	}
	switch dst.Type() {
	case zigObjectType:
		ref := src.get("$object").items()
		o, ok := (*Object)(nil), false
		if b != nil && len(ref) == 2 {
			o, ok = b.resolve(zigText(ref[0]), zigText(ref[1]))
		}
		if !ok {
			return fmt.Errorf("Zig named an unknown Object")
		}
		dst.Set(reflect.ValueOf(o))
		return nil
	case zigValueType:
		v, err := b.decodeValue(src)
		if err != nil {
			return err
		}
		dst.Set(reflect.ValueOf(v))
		return nil
	case zigPairType:
		items := src.items()
		if len(items) != 2 {
			return fmt.Errorf("invalid Zig variable pair")
		}
		dst.FieldByName("Key").SetString(zigText(items[0]))
		return zigDecodeResolving(items[1], dst.FieldByName("Val"), b)
	case zigTimeType:
		t, err := time.Parse(time.RFC3339Nano, zigText(src))
		if err != nil {
			return err
		}
		dst.Set(reflect.ValueOf(t))
		return nil
	case zigScriptErrorType:
		var data []Pair
		for _, pair := range src.entries() {
			switch pair.Key {
			case "code":
				dst.FieldByName("Code").SetString(zigText(pair.Val))
			case "message":
				dst.FieldByName("Message").SetString(zigText(pair.Val))
			default:
				var v Value
				if err := zigDecodeResolving(pair.Val, reflect.ValueOf(&v).Elem(), b); err != nil {
					return err
				}
				data = append(data, KV(pair.Key, v))
			}
		}
		v, err := Map(data...)
		if err != nil {
			return err
		}
		dst.FieldByName("Data").Set(reflect.ValueOf(v))
		return nil
	case reflect.TypeFor[GroupState]():
		return zigEnum(src, dst, map[string]int{"idle": int(Idle), "sliced": int(Sliced), "stopped": int(Stopped), "rewound": int(Rewound)})
	case reflect.TypeFor[Outcome]():
		return zigEnum(src, dst, map[string]int{"completed": int(Completed), "errored": int(Errored), "limit fault": int(LimitFault), "cancelled": int(Cancelled), "unhandled": int(UnhandledOutcome), "dropped": int(Dropped), "effect failed": int(EffectFailureOutcome)})
	case reflect.TypeFor[Verdict]():
		return zigEnum(src, dst, map[string]int{"allowed": int(Allowed), "vetoed": int(Vetoed), "undecided": int(Undecided)})
	case reflect.TypeFor[RunStatus]():
		return zigEnum(src, dst, map[string]int{"ready": int(Ready), "suspended": int(Suspended), "parked": int(Parked), "preempted": int(Preempted)})
	}
	switch dst.Kind() {
	case reflect.Pointer:
		dst.Set(reflect.New(dst.Type().Elem()))
		return zigDecodeResolving(src, dst.Elem(), b)
	case reflect.Struct:
		if !src.isMap() {
			return fmt.Errorf("invalid Zig %s", dst.Type())
		}
		members := src.entries()
		for _, f := range zigFields(dst.Type()) {
			if f.anonymous {
				if err := zigDecodeResolving(src, dst.Field(f.index), b); err != nil {
					return err
				}
				continue
			}
			var val zigReply
			for _, m := range members {
				if m.Key == f.key {
					val = m.Val
					break
				}
			}
			if err := zigDecodeResolving(val, dst.Field(f.index), b); err != nil {
				return fmt.Errorf("%s: %w", f.name, err)
			}
		}
	case reflect.Slice:
		if !src.isList() {
			return fmt.Errorf("expected Zig array for %s", dst.Type())
		}
		items := src.items()
		dst.Set(reflect.MakeSlice(dst.Type(), len(items), len(items)))
		for i, item := range items {
			if err := zigDecodeResolving(item, dst.Index(i), b); err != nil {
				return err
			}
		}
	case reflect.String:
		v, ok := src.text()
		if !ok {
			return fmt.Errorf("expected Zig text")
		}
		dst.SetString(v)
	case reflect.Bool:
		v, ok := src.boolean()
		if !ok {
			return fmt.Errorf("expected Zig boolean")
		}
		dst.SetBool(v)
	case reflect.Int, reflect.Int64:
		v, ok := src.int64()
		if !ok {
			return fmt.Errorf("expected Zig integer")
		}
		if dst.OverflowInt(v) {
			return fmt.Errorf("Zig integer overflow")
		}
		dst.SetInt(v)
	default:
		return fmt.Errorf("unsupported Zig field type %s", dst.Type())
	}
	return nil
}
func zigEnum(src zigReply, dst reflect.Value, values map[string]int) error {
	v, ok := values[zigText(src)]
	if !ok {
		return fmt.Errorf("unknown Zig %s %q", dst.Type(), zigText(src))
	}
	dst.SetInt(int64(v))
	return nil
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
	hello, err := b.send("hello", map[string]any{"protocol": 1, "features": append(slices.Clone(zigFeatures), zigOptionalFeatures...)})
	if err != nil {
		// A guest refuses a feature it does not know, leaving its session
		// unchanged, so ask again without the optional ones.
		hello, err = b.send("hello", map[string]any{"protocol": 1, "features": zigFeatures})
	}
	if err == nil {
		features := hello.get("features").items()
		for _, offered := range features {
			if zigText(offered) == "object-elements-v1" {
				b.reg.elements = true
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
	return err
}
