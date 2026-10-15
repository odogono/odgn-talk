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
	// Serializes one export/receipt and allocates monotonically increasing refs.
	// Full concurrent-input/worker admission is a later experimental-backend gate.
	frameMu   sync.Mutex
	ref       int64
	pendingMu sync.Mutex
	pending   map[DeliveryID]*Pending
	runs      map[RunID]DeliveryID
}

func newZigGroup(g *Group) groupBackend {
	reactor, err := zigEngine().Instantiate(context.Background())
	if err != nil {
		panic(err)
	}
	b := &zigGroup{group: g, reactor: reactor, pending: map[DeliveryID]*Pending{}, runs: map[RunID]DeliveryID{}}
	hello, err := b.send("hello", map[string]any{"protocol": 1, "features": []any{"abandoned-before-needs-v1"}})
	supported := false
	features := hello.Get("features")
	for i := 1; i <= features.Len(); i++ {
		if zigText(features.Index(i)) == "abandoned-before-needs-v1" {
			supported = true
		}
	}
	if err != nil || !supported {
		reactor.Close(context.Background())
		if err != nil {
			panic(err)
		}
		panic("embedded Zig artifact omits abandoned-before-needs-v1")
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

func (b *zigGroup) send(m string, fields map[string]any) (Value, error) {
	defer runtime.KeepAlive(b)
	b.frameMu.Lock()
	b.ref++
	fields["m"] = m
	fields["ref"] = b.ref
	fields["group"] = "g"
	data, err := zigJSON(nil, fields)
	var packet Value
	if err == nil {
		data, err = b.reactor.Frame(context.Background(), data)
	}
	if err == nil {
		packet, err = DecodeJSON(data)
	}
	if err == nil {
		n, ok := packet.Get("ref").AsDec()
		if !ok {
			err = fmt.Errorf("Zig reply omitted ref")
		} else if got, e := n.Int64(); e != nil || got != b.ref {
			err = fmt.Errorf("Zig reply ref mismatch")
		}
	}
	b.frameMu.Unlock()
	if err != nil {
		return Nothing, err
	}
	ok := packet.Get("ok")
	// Trace sinks run outside the export lock. This first slice accepts
	// observational sinks; callback-generated inputs need broader acceptance.
	if trace := ok.Get("trace"); trace.Kind() == KindList {
		for i := 1; i <= trace.Len(); i++ {
			b.group.emit(zigText(trace.Index(i)))
		}
	}
	if failure := packet.Get("err"); failure.Kind() != KindNothing {
		switch zigText(failure.Get("kind")) {
		case "host error":
			return Nothing, &HostError{Code: HostErrorCode(zigText(failure.Get("code"))), Detail: zigText(failure.Get("detail"))}
		case "mailbox full":
			return Nothing, ErrMailboxFull
		case "load error":
			rejected := new(LoadError)
			if err := zigDecode(failure, reflect.ValueOf(rejected).Elem()); err != nil {
				return Nothing, err
			}
			return Nothing, rejected
		default:
			return Nothing, fmt.Errorf("Zig Message Layer: %s", zigText(failure.Get("detail")))
		}
	}
	if packet.Get("need").Kind() != KindNothing {
		return Nothing, backendUnsupported("Host callbacks")
	}
	return ok, nil
}

func (b *zigGroup) load(o LoadOptions) (*Script, error) {
	if len(o.Grants) > 0 || len(o.Objects) > 0 || o.Owner != nil {
		return nil, backendUnsupported("Capabilities and Objects")
	}
	if err := b.group.beginWorker(); err != nil {
		return nil, err
	}
	defer b.group.endWorker()
	fields := map[string]any{"name": o.Name, "source": o.Source}
	limits, err := zigLimits(o.Limits)
	if err != nil {
		return nil, err
	}
	fields["limits"] = limits
	if _, err = b.send("load", fields); err != nil {
		return nil, err
	}
	s := &Script{group: b.group, name: o.Name, source: o.Source, limits: o.Limits}
	b.group.mu.Lock()
	b.group.scripts = append(b.group.scripts, s)
	b.group.mu.Unlock()
	return s, nil
}

func (b *zigGroup) admit(s *Script, m Message, ctx context.Context, request bool) (DeliveryID, *Pending, error) {
	if s == nil || s.group != b.group {
		return "", nil, &HostError{WrongGroup, "receiver does not belong to Group"}
	}
	args := make([]any, len(m.Args))
	for i, v := range m.Args {
		if err := zigDataOnly(v); err != nil {
			return "", nil, err
		}
		encoded, err := EncodeValue(v)
		if err != nil {
			return "", nil, err
		}
		args[i] = json.RawMessage(encoded)
	}
	message := map[string]any{"name": m.Name, "args": args}
	if m.Limits != nil {
		limits, err := zigOverride(*m.Limits)
		if err != nil {
			return "", nil, err
		}
		message["limits"] = limits
	}
	method := "deliver"
	if request {
		method = "request"
	}
	// Pending registration and Pump result handling share this lock so an input
	// cannot complete between its receipt and its Go future's registration.
	b.pendingMu.Lock()
	reply, err := b.send(method, map[string]any{"to": map[string]any{"script": s.name}, "message": message})
	if err != nil {
		b.pendingMu.Unlock()
		return "", nil, err
	}
	id := DeliveryID(zigText(reply.Get("delivery")))
	var pending *Pending
	if request {
		pending = &Pending{done: make(chan struct{})}
		b.pending[id] = pending
		if ctx != nil {
			pending.stop = context.AfterFunc(ctx, func() {
				if _, err := b.send("cancel-delivery", map[string]any{"delivery": string(id)}); err != nil {
					panic(err)
				}
				b.ready()
			})
		}
	}
	b.pendingMu.Unlock()
	b.ready()
	return id, pending, nil
}

func (b *zigGroup) ready() {
	if b.group.options.OnReady != nil {
		b.group.options.OnReady()
	}
}

func (b *zigGroup) pump(now time.Time, options PumpOptions) (PumpResult, error) {
	if err := b.group.beginWorker(); err != nil {
		return PumpResult{}, err
	}
	defer b.group.endWorker()
	reply, err := b.send("pump", map[string]any{"now": now.Round(0).UTC().Format(time.RFC3339Nano), "fuelSlice": options.FuelSlice, "fuelCap": options.FuelCap})
	if err != nil {
		return PumpResult{}, err
	}
	var result PumpResult
	if err = zigDecode(reply, reflect.ValueOf(&result).Elem()); err != nil {
		return result, err
	}
	rows := reply.Get("reports")
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
		default:
			return result, backendUnsupported("Report " + zigText(row.Get("kind")))
		}
		if err = zigDecode(row, reflect.ValueOf(report).Elem()); err != nil {
			return result, err
		}
		result.Reports = append(result.Reports, report)
	}
	b.pendingMu.Lock()
	defer b.pendingMu.Unlock()
	settle := func(id DeliveryID, value Value, failure *ScriptError) {
		if p := b.pending[id]; p != nil {
			delete(b.pending, id)
			p.settle(value, failure)
		}
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
	if err := b.group.beginWorker(); err != nil {
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
	if err = zigDecode(reply, reflect.ValueOf(&inspection).Elem()); err != nil {
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

func zigDataOnly(v Value) error {
	stack := []Value{v}
	for len(stack) > 0 {
		v = stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		switch v.Kind() {
		case KindFunction, KindObject:
			return backendUnsupported("Function and Object Values")
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
func zigDecode(src Value, dst reflect.Value) error {
	if src.Kind() == KindNothing {
		return nil
	}
	if dst.Type() == reflect.TypeFor[Value]() {
		raw, err := EncodeJSON(src)
		if err != nil {
			return err
		}
		v, err := DecodeValue(raw, nil)
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
		return zigDecode(src.Index(2), dst.FieldByName("Val"))
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
				if err := zigDecode(pair.Val, reflect.ValueOf(&v).Elem()); err != nil {
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
	case reflect.TypeFor[RunStatus]():
		return zigEnum(src, dst, map[string]int{"ready": int(Ready), "suspended": int(Suspended), "parked": int(Parked), "preempted": int(Preempted)})
	}
	switch dst.Kind() {
	case reflect.Pointer:
		dst.Set(reflect.New(dst.Type().Elem()))
		return zigDecode(src, dst.Elem())
	case reflect.Struct:
		if src.Kind() != KindMap {
			return fmt.Errorf("invalid Zig %s", dst.Type())
		}
		for i := 0; i < dst.NumField(); i++ {
			f := dst.Type().Field(i)
			if f.Anonymous {
				if err := zigDecode(src, dst.Field(i)); err != nil {
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
			if err := zigDecode(src.Get(key), dst.Field(i)); err != nil {
				return fmt.Errorf("%s: %w", f.Name, err)
			}
		}
	case reflect.Slice:
		if src.Kind() != KindList {
			return fmt.Errorf("expected Zig array for %s", dst.Type())
		}
		dst.Set(reflect.MakeSlice(dst.Type(), src.Len(), src.Len()))
		for i := 0; i < src.Len(); i++ {
			if err := zigDecode(src.Index(i+1), dst.Index(i)); err != nil {
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
