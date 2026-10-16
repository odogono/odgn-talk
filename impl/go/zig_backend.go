//go:build talk_zig_experimental

package northtalk

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

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
		var packet Value
		if err == nil {
			packet, err = DecodeJSON(data)
		}
		if err == nil {
			err = zigDecode(packet.Get("ok"), reflect.ValueOf(&zigCompiled.versions).Elem())
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
	// Admission during a non-yielding export remains a separate gate.
	frameMu   sync.Mutex
	ref       int64
	pendingMu sync.Mutex
	pending   map[DeliveryID]*Pending
	decisions map[string]*Deciding
	// Property crossings' Host details, in crossing order, for this Pump.
	propertyDetails []string
	kindsMu         sync.Mutex
	kinds           map[string]*ObjectKind
	runs            map[RunID]DeliveryID
	definitions     map[*CapabilityDef]string
	callsMu         sync.Mutex
	calls           map[CallID]context.CancelFunc
	failureDetails  map[CallID]string
	paused          bool
}

func newZigGroup(g *Group) groupBackend {
	reactor, err := zigEngine().Instantiate(context.Background())
	if err != nil {
		panic(err)
	}
	b := &zigGroup{group: g, reactor: reactor, pending: map[DeliveryID]*Pending{}, decisions: map[string]*Deciding{}, kinds: map[string]*ObjectKind{}, runs: map[RunID]DeliveryID{}, definitions: map[*CapabilityDef]string{}, calls: map[CallID]context.CancelFunc{}, failureDetails: map[CallID]string{}}
	hello, err := b.send("hello", map[string]any{"protocol": 1, "features": []any{"paused-inputs-v1", "abandoned-before-needs-v1", "crossing-trace-v1", "climb-v1", "function-gone-v1"}})
	if err == nil {
		features := hello.Get("features")
		for _, required := range []string{"paused-inputs-v1", "abandoned-before-needs-v1", "crossing-trace-v1", "climb-v1", "function-gone-v1"} {
			found := false
			for i := 1; i <= features.Len(); i++ {
				if zigText(features.Index(i)) == required {
					found = true
				}
			}
			if !found {
				err = fmt.Errorf("embedded Zig artifact omits %s", required)
				break
			}
		}
	}
	if err != nil {
		reactor.Close(context.Background())
		panic(err)
	}
	if _, err = b.send("new-group", map[string]any{"name": g.Name(), "trace": g.options.Trace != nil}); err != nil {
		reactor.Close(context.Background())
		panic(err)
	}
	// The cleanup argument owns only the guest module, never the Group or its
	// callbacks. Group/Script/future references keep the Group alive normally.
	runtime.AddCleanup(g, func(r *zigwasm.Reactor) { r.Close(context.Background()) }, reactor)
	return b
}

// exchange reserves the worker ref across every need/result. Inputs use their
// own refs; no Host callback or Trace sink runs under an export/registry lock.
func (b *zigGroup) send(m string, fields map[string]any) (Value, error) {
	return b.exchange(m, fields, nil)
}
func (b *zigGroup) exchange(m string, fields map[string]any, receipt func(Value) error) (Value, error) {
	defer runtime.KeepAlive(b)
	var ref int64
	for {
		b.frameMu.Lock()
		if ref == 0 {
			b.ref++
			ref = b.ref
		}
		fields["m"], fields["ref"], fields["group"] = m, ref, "g"
		packet, err := b.frame(fields)
		if err == nil && packet.Get("need").Kind() == KindNothing && packet.Get("err").Kind() == KindNothing && receipt != nil {
			err = receipt(packet.Get("ok"))
		}
		b.frameMu.Unlock()
		b.observe(packet, m)
		if err != nil {
			return Nothing, err
		}
		if failure := packet.Get("err"); failure.Kind() != KindNothing {
			return Nothing, zigFailure(failure)
		}
		need := packet.Get("need")
		if need.Kind() == KindNothing {
			return packet.Get("ok"), nil
		}
		fields, err = b.callback(need)
		if err != nil {
			return Nothing, err
		}
		m = zigText(need.Get("m")) + "-result"
	}
}

// observe publishes every reply outside the export lock, including refused
// reentrant worker calls which can carry earlier buffered Trace records.
func (b *zigGroup) observe(packet Value, m string) {
	b.abandoned(packet.Get("abandoned"))
	b.abandoned(packet.Get("ok").Get("abandoned"))
	b.settled(packet.Get("settled"))
	b.settled(packet.Get("ok").Get("settled"))
	sources := []Value{packet}
	// Grants is a name-to-Operations map; "trace" is a legal Grant name,
	// and Grant inspection itself produces no Trace records.
	if m != "grants" {
		sources = append(sources, packet.Get("ok"))
	}
	for _, source := range sources {
		trace := source.Get("trace")
		for i := 1; i <= trace.Len(); i++ {
			b.group.emit(zigText(trace.Index(i)))
		}
	}
}

// frame is called with frameMu held; replies and all Values own Go memory.
func (b *zigGroup) frame(fields map[string]any) (Value, error) {
	data, err := zigJSON(nil, fields)
	if err != nil {
		return Nothing, err
	}
	data, err = b.reactor.Frame(context.Background(), data)
	if err != nil {
		return Nothing, err
	}
	packet, err := DecodeJSON(data)
	if err != nil {
		return Nothing, err
	}
	n, ok := packet.Get("ref").AsDec()
	if !ok {
		return Nothing, fmt.Errorf("Zig reply omitted ref")
	}
	if got, e := n.Int64(); e != nil || got != fields["ref"] {
		return Nothing, fmt.Errorf("Zig reply ref mismatch")
	}
	if packet.Get("need").Kind() != KindNothing {
		b.paused = true
	} else if fields["m"] == "pump" || fields["m"] == "op-result" || fields["m"] == "trace-result" || fields["m"] == "release-result" {
		b.paused = false
	}
	return packet, nil
}
func zigFailure(failure Value) error {
	switch zigText(failure.Get("kind")) {
	case "host error":
		return &HostError{Code: HostErrorCode(zigText(failure.Get("code"))), Detail: zigText(failure.Get("detail"))}
	case "mailbox full":
		return ErrMailboxFull
	case "load error":
		rejected := new(LoadError)
		if err := zigDecode(failure, reflect.ValueOf(rejected).Elem()); err != nil {
			return err
		}
		return rejected
	default:
		return fmt.Errorf("Zig Message Layer: %s", zigText(failure.Get("detail")))
	}
}

// A rejected worker never starts a second conversation. While paused, ask the
// transport to record the refusal in the current crossing's Trace order.
func (b *zigGroup) beginWorker(m string, fields map[string]any) error {
	err := b.group.beginWorker()
	if err == nil {
		return nil
	}
	var packet Value
	b.frameMu.Lock()
	if b.paused {
		b.ref++
		fields["m"], fields["ref"], fields["group"] = m, b.ref, "g"
		var frameErr error
		packet, frameErr = b.frame(fields)
		b.paused = true // the refusal leaves the enclosing need outstanding
		if frameErr != nil {
			err = frameErr
		}
	}
	b.frameMu.Unlock()
	b.observe(packet, m)
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
	_, err = b.exchange("load", fields, func(Value) error {
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
	_, err = b.exchange(method, fields, func(reply Value) error {
		id = DeliveryID(zigText(reply.Get("delivery")))
		if strings.HasSuffix(how, "broadcast") {
			id = DeliveryID(zigText(reply.Get("broadcast")))
		}
		cancel := func() {
			if _, err := b.send("cancel-delivery", map[string]any{"delivery": string(id)}); err != nil {
				panic(err)
			}
			b.ready()
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

func (b *zigGroup) pump(now time.Time, options PumpOptions) (PumpResult, error) {
	fields := map[string]any{"now": now.Round(0).UTC().Truncate(time.Microsecond).Format(time.RFC3339Nano), "fuelSlice": options.FuelSlice, "fuelCap": options.FuelCap}
	if err := b.beginWorker("pump", fields); err != nil {
		return PumpResult{}, err
	}
	defer b.group.endWorker()
	if err := b.syncKinds(); err != nil {
		return PumpResult{}, err
	}
	var result PumpResult
	_, err := b.exchange("pump", fields, func(reply Value) error {
		var err error
		result, err = b.pumpReceipt(reply)
		return err
	})

	return result, err
}
func (b *zigGroup) pumpReceipt(reply Value) (PumpResult, error) {
	var result PumpResult
	if err := b.decode(reply, reflect.ValueOf(&result).Elem()); err != nil {
		return result, err
	}
	rows := reply.Get("reports")
	// A Run whose message climbed the Message Path hasn't answered its asker.
	climbed := map[Report]bool{}
	for i := 1; i <= rows.Len(); i++ {
		row := rows.Index(i)
		var report Report
		switch zigText(row.Get("kind")) {
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
		case "call failed":
			report = &CallFailed{}
		case "decided":
			report = &Decided{}
		default:
			return result, backendUnsupported("Report " + zigText(row.Get("kind")))
		}
		if err := b.decode(row, reflect.ValueOf(report).Elem()); err != nil {
			return result, err
		}
		if failed, ok := report.(*CallFailed); ok && failed.Call == "" {
			// A property failure: the next unconsumed property detail.
			if len(b.propertyDetails) > 0 {
				failed.Detail, b.propertyDetails = b.propertyDetails[0], b.propertyDetails[1:]
			}
		} else if ok {
			failed.Detail = b.failureDetails[failed.Call]
			for def, handle := range b.definitions {
				if failed.Operation.Capability == handle {
					failed.Operation.Capability = def.name
					break
				}
			}
		}
		if c, _ := row.Get("climbed").AsBool(); c {
			climbed[report] = true
		}
		result.Reports = append(result.Reports, report)
	}
	clear(b.failureDetails)
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
	gone := reply.Get("gone")
	for i := 1; i <= gone.Len(); i++ {
		settle(DeliveryID(zigText(gone.Index(i))), Nothing, sendFailure("function gone", nil))
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

func (b *zigGroup) worker(method string, fields map[string]any) (Value, error) {
	if err := b.beginWorker(method, fields); err != nil {
		return Nothing, err
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
func (b *zigGroup) fingerprint() [32]byte { panic(backendUnsupported("Fingerprint")) }

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

// The envelope decoder uses the existing iterative JSON/value utility. Data
// payloads are then decoded as Value Encodings, preserving tags and decimals.
func zigDecode(src Value, dst reflect.Value) error { return zigDecodeResolving(src, dst, nil) }

// decode resolves Object handles and Function Values in Value Encodings
// against this Group.
func (b *zigGroup) decode(src Value, dst reflect.Value) error {
	return zigDecodeResolving(src, dst, b)
}

func zigDecodeResolving(src Value, dst reflect.Value, b *zigGroup) error {
	var resolve func(kind, id string) (*Object, bool)
	if b != nil {
		resolve = b.resolve
	}
	if src.Kind() == KindNothing {
		return nil
	}
	if dst.Type() == reflect.TypeFor[*Object]() {
		ref := src.Get("$object")
		o, ok := (*Object)(nil), false
		if resolve != nil {
			o, ok = resolve(zigText(ref.Index(1)), zigText(ref.Index(2)))
		}
		if !ok {
			return fmt.Errorf("Zig named an unknown Object")
		}
		dst.Set(reflect.ValueOf(o))
		return nil
	}
	if dst.Type() == reflect.TypeFor[Value]() {
		raw, err := EncodeJSON(src)
		if err != nil {
			return err
		}
		v, err := b.decodeValue(raw)
		if err != nil {
			return err
		}
		dst.Set(reflect.ValueOf(v))
		return nil
	}
	if dst.Type() == reflect.TypeFor[Pair]() {
		if src.Kind() != KindList || src.Len() != 2 {
			return fmt.Errorf("invalid Zig variable pair")
		}
		dst.FieldByName("Key").SetString(zigText(src.Index(1)))
		return zigDecodeResolving(src.Index(2), dst.FieldByName("Val"), b)
	}
	if dst.Type() == reflect.TypeFor[time.Time]() {
		t, err := time.Parse(time.RFC3339Nano, zigText(src))
		if err != nil {
			return err
		}
		dst.Set(reflect.ValueOf(t))
		return nil
	}
	if dst.Type() == reflect.TypeFor[ScriptError]() {
		dst.FieldByName("Code").SetString(zigText(src.Get("code")))
		dst.FieldByName("Message").SetString(zigText(src.Get("message")))
		var data []Pair
		for _, pair := range src.Entries() {
			if pair.Key != "code" && pair.Key != "message" {
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
	}
	switch dst.Type() {
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
		if src.Kind() != KindMap {
			return fmt.Errorf("invalid Zig %s", dst.Type())
		}
		for i := 0; i < dst.NumField(); i++ {
			f := dst.Type().Field(i)
			if f.Anonymous {
				if err := zigDecodeResolving(src, dst.Field(i), b); err != nil {
					return err
				}
				continue
			}
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
			if err := zigDecodeResolving(src.Get(key), dst.Field(i), b); err != nil {
				return fmt.Errorf("%s: %w", f.Name, err)
			}
		}
	case reflect.Slice:
		if src.Kind() != KindList {
			return fmt.Errorf("expected Zig array for %s", dst.Type())
		}
		dst.Set(reflect.MakeSlice(dst.Type(), src.Len(), src.Len()))
		for i := 0; i < src.Len(); i++ {
			if err := zigDecodeResolving(src.Index(i+1), dst.Index(i), b); err != nil {
				return err
			}
		}
	case reflect.String:
		v, ok := src.AsText()
		if !ok {
			return fmt.Errorf("expected Zig text")
		}
		dst.SetString(v)
	case reflect.Bool:
		v, ok := src.AsBool()
		if !ok {
			return fmt.Errorf("expected Zig boolean")
		}
		dst.SetBool(v)
	case reflect.Int, reflect.Int64:
		n, ok := src.AsDec()
		if !ok {
			return fmt.Errorf("expected Zig integer")
		}
		v, err := n.Int64()
		if err != nil {
			return err
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
func zigEnum(src Value, dst reflect.Value, values map[string]int) error {
	v, ok := values[zigText(src)]
	if !ok {
		return fmt.Errorf("unknown Zig %s %q", dst.Type(), zigText(src))
	}
	dst.SetInt(int64(v))
	return nil
}
func zigText(v Value) string { s, _ := v.AsText(); return s }

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
	case map[string]any:
		out = append(out, '{')
		keys := make([]string, 0, len(v))
		for key := range v {
			keys = append(keys, key)
		}
		sort.Strings(keys)
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
