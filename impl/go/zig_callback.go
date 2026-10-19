//go:build talk_zig_experimental

package northtalk

import (
	"context"
	"errors"
	"fmt"
	"os"
	"reflect"
	"time"
	"unicode/utf8"

	"github.com/odogono/odgn-talk/impl/go/internal/shape"
	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
)

// Host callbacks (op, prop, effect and release needs) cross in the binary
// fields envelope when the guest takes callbacks-fields-v1 (#1311). An
// explicit empty TALK_ZIG_CALLBACKS keeps JSON for compatibility checks.
var zigCallbacks = func() string {
	if layout, ok := os.LookupEnv("TALK_ZIG_CALLBACKS"); ok {
		return layout
	}
	return "fields"
}()

const zigCallbacksFeature = "callbacks-fields-v1"

// zigCallbacksWanted reports whether hello asks for callbacks-fields-v1.
func zigCallbacksWanted() (bool, error) {
	switch zigCallbacks {
	case "":
		return false, nil
	case "fields":
		return true, nil
	}
	return false, fmt.Errorf("TALK_ZIG_CALLBACKS must be fields or empty, not %q", zigCallbacks)
}

// Callback needs and results: a message tag and its positional fields. A
// need's notices come last.
const (
	zbOpResult      byte = 0x06
	zbPropResult    byte = 0x07
	zbEffectResult  byte = 0x08
	zbReleaseResult byte = 0x09
	zbOpNeed        byte = 0x83
	zbPropNeed      byte = 0x84
	zbEffectNeed    byte = 0x85
	zbReleaseNeed   byte = 0x86
)

var zbCallbacks = map[byte]struct {
	kind   string
	fields []string
}{
	zbOpResult:      {"", []string{"ref", "group", "outcome", "value", "code", "message", "charged"}},
	zbPropResult:    {"", []string{"ref", "group", "outcome", "value", "code", "message", "charged"}},
	zbEffectResult:  {"", []string{"ref", "group", "status"}},
	zbReleaseResult: {"", []string{"ref", "group"}},
	zbOpNeed:        {"op", []string{"ref", "call", "script", "run", "segment", "grant", "capability", "operation", "mode", "now", "args", "scope", "automatic", "fuelLeft", "abandoned", "settled", "trace"}},
	zbPropNeed:      {"prop", []string{"ref", "object", "prop", "set", "value", "op", "selector", "abandoned", "settled", "trace"}},
	zbEffectNeed:    {"effect", []string{"ref", "script", "run", "segment", "grant", "grants", "coordinator", "phase", "now", "abandoned", "settled", "trace"}},
	zbReleaseNeed:   {"release", []string{"ref", "script", "grant", "reason", "now", "abandoned", "settled", "trace"}},
}

// zbNeed is a binary callback need: its tag and positional fields.
type zbNeed struct {
	tag  byte
	view zbView
}

// zigNeed is a callback need read from either envelope. Decoding failures
// are kept, so each is refused at the point the JSON reader always refused it.
type zigNeed struct {
	kind                                               string
	script, grant, reason, operation, capability, call string
	scope, run, segment, phase                         string
	now                                                time.Time
	nowErr                                             error
	args                                               []Value
	argErr                                             error
	automatic                                          bool
	fuelLeft                                           int64
	limited                                            bool
	fuelErr                                            error
	grants                                             []string
	objectKind, objectID, prop, op                     string
	object                                             bool
	set, collection, selected                          bool
	value, selector                                    Value
	valueErr                                           error
}

// zigNow reads a need's Host clock reading. A Run's callbacks repeat one
// reading, so the last one parsed is reused.
func (b *zigGroup) zigNow(raw zigReply) (time.Time, error) {
	if len(raw) != 0 && string(raw) == b.nowRaw {
		return b.now, nil
	}
	now, err := time.Parse(time.RFC3339Nano, zigText(raw))
	if err != nil {
		return time.Time{}, err
	}
	b.nowRaw, b.now = string(raw), now
	return now, nil
}

// zigReadNeed reads a JSON need's fields.
func (b *zigGroup) zigReadNeed(kind string, need zigReply) zigNeed {
	n := zigNeed{kind: kind}
	if kind == "prop" {
		var fields [4]zigReply
		need.lookup(zigPropertyNeedKeys, fields[:])
		if ref := fields[0].get("$object").items(); len(ref) == 2 {
			n.object, n.objectKind, n.objectID = true, zigText(ref[0]), zigText(ref[1])
		}
		n.prop, n.op = zigText(fields[1]), zigText(fields[3])
		// Presence, including an explicit null, distinguishes a setter from a getter.
		n.set, n.collection = fields[2] != nil, fields[3] != nil
		if n.set && !n.collection {
			n.value, n.valueErr = b.decodeInto(fields[2])
		}
		if !n.collection {
			return n
		}
		for _, entry := range need.entries() {
			if entry.Key == "selector" {
				n.selected = true
				var err error
				if n.selector, err = b.decodeInto(need.get("selector")); err != nil {
					n.valueErr = err
				}
			}
		}
		return n
	}
	f := zigReadCallNeed(need)
	n.script, n.grant, n.reason, n.operation = zigText(f.script), zigText(f.grant), zigText(f.reason), zigText(f.operation)
	n.capability, n.call, n.scope, n.run, n.segment = zigText(f.capability), zigText(f.call), zigText(f.scope), zigText(f.run), zigText(f.segment)
	n.now, n.nowErr = b.zigNow(f.now)
	if kind == "effect" {
		n.phase = zigText(need.get("phase"))
		n.grants = []string{}
		for _, raw := range need.get("grants").items() {
			n.grants = append(n.grants, zigText(raw))
		}
		return n
	}
	if kind == "op" {
		for _, raw := range f.args.items() {
			v, err := b.decodeValue(raw)
			if err != nil {
				n.argErr = err
				break
			}
			n.args = append(n.args, v)
		}
		n.automatic, _ = f.automatic.boolean()
		if n.limited = f.fuelLeft.present(); n.limited {
			var ok bool
			if n.fuelLeft, ok = f.fuelLeft.int64(); !ok {
				n.fuelErr = fmt.Errorf("Zig callback has an invalid fuelLeft")
			}
		}
	}
	return n
}

// decodeInto reads one JSON Value as decode does.
func (b *zigGroup) decodeInto(src zigReply) (Value, error) {
	var v Value
	err := b.decode(src, reflect.ValueOf(&v).Elem())
	return v, err
}

// zbReadNeed reads a binary need's fields.
func (b *zigGroup) zbReadNeed(p *zbNeed) zigNeed {
	v := p.view
	text := func(key string) string { s, _ := zbText(v.get(key)); return s }
	n := zigNeed{kind: zbCallbacks[p.tag].kind}
	if p.tag == zbPropNeed {
		if ref, err := zbTexts(v.get("object")); err == nil && len(ref) == 2 {
			n.object, n.objectKind, n.objectID = true, ref[0], ref[1]
		}
		n.prop, n.op = text("prop"), text("op")
		set := v.get("set")
		n.set, n.collection = len(set) == 1 && set[0] == 0x02, v.get("op") != nil
		if n.set && !n.collection {
			n.value, n.valueErr = b.zbDecodeOptional(v.get("value"))
		}
		if span := v.get("selector"); span != nil {
			n.selected = true
			if n.selector, n.valueErr = b.zbDecodeValue(span); n.valueErr != nil {
				n.selector = Nothing
			}
		}
		return n
	}
	n.script, n.grant, n.reason, n.operation = text("script"), text("grant"), text("reason"), text("operation")
	n.capability, n.call, n.scope, n.run, n.segment, n.phase = text("capability"), text("call"), text("scope"), text("run"), text("segment"), text("phase")
	if t, ok := zbInstant(v.get("now")); ok {
		n.now = t
	} else {
		n.nowErr = errZigBinary
	}
	if p.tag == zbEffectNeed {
		var err error
		if n.grants, err = zbTexts(v.get("grants")); err != nil || n.grants == nil {
			n.grants = []string{}
		}
		return n
	}
	if p.tag == zbOpNeed {
		n.args, n.argErr = b.zbDecodeValues(v.get("args"))
		a := v.get("automatic")
		n.automatic = len(a) == 1 && a[0] == 0x02
		if span := v.get("fuelLeft"); span != nil {
			var ok bool
			n.limited = true
			if n.fuelLeft, ok = zbInt(span); !ok {
				n.fuelErr = fmt.Errorf("Zig callback has an invalid fuelLeft")
			}
		}
	}
	return n
}

func (b *zigGroup) zbDecodeOptional(span []byte) (Value, error) {
	if span == nil {
		return Nothing, nil
	}
	return b.zbDecodeValue(span)
}

// zigResult is a callback's result, its Values already encoded for the
// envelope it returns in.
type zigResult struct {
	bin bool
	// outcome is the JSON result key: result, started, done, fail, limit,
	// hostError, value or ok; status for an effect; empty for a release.
	outcome       string
	charged       int64
	detail        string // a hostError's
	status        string
	json          any    // the JSON result, value or failure
	value         []byte // the binary result, value or failure Data
	code, message string // the binary failure's
}

func (b *zigGroup) encodeResult(r *zigResult, v Value) error {
	if !r.bin {
		raw, err := b.zigEncoded(v)
		r.json = raw
		return err
	}
	var w zbWriter
	if err := b.zbValue(&w, v); err != nil {
		return err
	}
	r.value = w.buf
	return nil
}

func (b *zigGroup) encodeFailure(r *zigResult, e *ScriptError) error {
	if !r.bin {
		m, err := b.zigScriptFailure(e)
		r.json = m
		return err
	}
	if !utf8.ValidString(e.Code) || !utf8.ValidString(e.Message) {
		return &HostError{InvalidValue, "invalid UTF-8 in a failure"}
	}
	var w zbWriter
	if err := b.zbValue(&w, e.Data); err != nil {
		return err
	}
	r.value, r.code, r.message = w.buf, e.Code, e.Message
	return nil
}

func (r *zigResult) hostError(detail string) {
	r.outcome, r.detail, r.json, r.value = "hostError", detail, nil, nil
}

// fields is the result as a JSON frame's fields.
func (r *zigResult) fields() map[string]any {
	out := map[string]any{}
	if r.charged != 0 {
		out["charged"] = r.charged
	}
	switch r.outcome {
	case "":
	case "result", "value", "fail":
		out[r.outcome] = r.json
	case "hostError":
		out["hostError"] = r.detail
	case "status":
		out["status"] = r.status
	default:
		out[r.outcome] = true
	}
	return out
}

// zbResult is the result as a binary frame answering a need of tag need.
func (b *zigGroup) zbResult(need byte, r *zigResult) *zbFrame {
	tag := need - zbOpNeed + zbOpResult
	w := &zbWriter{buf: make([]byte, 0, 24+len(r.value)+len(r.code)+len(r.message))}
	w.buf = append(append(w.buf, zbPrefix...), byte(zbFields), tag)
	w.begin(zbCallbacks[tag].fields, true)
	w.key("ref")
	split := len(w.buf)
	w.key("group")
	w.ptext(b.groupHandle())
	switch tag {
	case zbEffectResult:
		w.key("status")
		w.ptext(r.status)
	case zbOpResult, zbPropResult:
		w.key("outcome")
		w.ptext(r.outcome)
		if r.value != nil {
			w.key("value")
			w.buf = append(w.buf, r.value...)
		}
		if r.outcome == "fail" {
			w.key("code")
			w.ptext(r.code)
			if r.message != "" {
				w.key("message")
				w.ptext(r.message)
			}
		}
		if r.charged != 0 {
			w.key("charged")
			w.int(r.charged)
		}
	}
	return w.frame(split, true, nil)
}

// callback answers a JSON need with a JSON result's fields.
func (b *zigGroup) callback(need zigReply) (map[string]any, error) {
	kind := zigText(need.get("m"))
	switch kind {
	case "trace":
		return map[string]any{}, nil
	case "resolve":
		return b.restoreBindings(need)
	case "op", "release", "prop", "effect":
	default:
		return nil, backendUnsupported("Host callback " + kind)
	}
	n := b.zigReadNeed(kind, need)
	r, err := b.answer(&n, false)
	if err != nil {
		return nil, err
	}
	return r.fields(), nil
}

// callbackBinary answers a binary need with a binary result frame.
func (b *zigGroup) callbackBinary(p *zbNeed) (*zbFrame, error) {
	n := b.zbReadNeed(p)
	r, err := b.answer(&n, true)
	if err != nil {
		return nil, err
	}
	return b.zbResult(p.tag, &r), nil
}

func (b *zigGroup) answer(n *zigNeed, bin bool) (zigResult, error) {
	r := zigResult{bin: bin}
	var err error
	switch n.kind {
	case "prop":
		err = b.property(n, &r)
	case "effect":
		err = b.effect(n, &r)
	default:
		err = b.operation(n, &r)
	}
	return r, err
}

// Operation and release needs share this envelope. Read its spans once rather
// than walking the whole JSON object again for each Call field.
type zigCallNeed struct {
	script, grant, now, reason, operation, capability, args zigReply
	call, automatic, scope, run, segment, fuelLeft          zigReply
}

var zigCallNeedKeys = []string{"script", "grant", "now", "reason", "operation", "capability", "args", "call", "automatic", "scope", "run", "segment", "fuelLeft"}

func zigReadCallNeed(need zigReply) zigCallNeed {
	var f [13]zigReply
	need.lookup(zigCallNeedKeys, f[:])
	return zigCallNeed{script: f[0], grant: f[1], now: f[2], reason: f[3], operation: f[4], capability: f[5], args: f[6], call: f[7], automatic: f[8], scope: f[9], run: f[10], segment: f[11], fuelLeft: f[12]}
}

// operation answers an op or release need.
func (b *zigGroup) operation(n *zigNeed, out *zigResult) error {
	s := b.group.Script(n.script)
	if s == nil {
		return fmt.Errorf("Zig callback names an unknown Script")
	}
	grantName := n.grant
	grant := s.grants[grantName]
	if grant == nil {
		return fmt.Errorf("Zig callback names an unknown Grant")
	}
	if n.kind == "release" {
		if grant.definition.release == nil {
			return fmt.Errorf("Zig release names a Grant without a release hook")
		}
		if n.nowErr != nil {
			return n.nowErr
		}
		reason := ReleaseReason(n.reason)
		switch reason {
		case ReleaseStop, ReleaseReload, ReleaseRevoke, ReleaseDisable:
		default:
			return fmt.Errorf("unknown Zig Grant release reason %q", reason)
		}
		invokeReleaseHook(grant.definition.release, GrantContext{Group: b.group, ScriptName: s.name, GrantName: grantName, Binding: grant.binding, Now: n.now, Reason: reason})
		return nil
	}
	name := n.operation
	op, ok := grant.definition.ops[name]
	if !ok || !grant.operations[name] || n.capability != b.reg.handle(grant.definition) {
		return fmt.Errorf("Zig callback does not match its Grant")
	}
	if n.argErr != nil {
		detail := n.argErr.Error()
		b.failureDetails[CallID(n.call)] = detail
		out.hostError(detail)
		return nil
	}
	if n.nowErr != nil {
		return n.nowErr
	}
	ctx, cancel := operationContext(op.Mode)
	automatic := n.automatic
	if automatic {
		ctx = context.Background()
	}
	c := &Call{automatic: automatic, scopeName: n.scope, group: b.group, scriptName: s.name, runID: RunID(n.run), grantName: grantName, binding: grant.binding, id: CallID(n.call), segmentID: n.segment, now: n.now, context: ctx, starting: true}
	if n.fuelErr != nil {
		cancel()
		return n.fuelErr
	}
	left, limited := n.fuelLeft, n.limited
	c.charge = func(fuel int64) bool {
		if limited && fuel > left {
			return false
		}
		left -= fuel
		return true
	}
	c.fuelLeft = func() (int64, bool) { return left, limited }
	if op.Mode == Suspending {
		b.callsMu.Lock()
		b.calls[c.id] = cancel
		b.callsMu.Unlock()
	}
	result, failure := invokeOperation(op, c, n.args)
	c.finish()
	if c.invalidAutomatic {
		failure = &HostError{InvalidValue, "automatic abandonment attempted a budget or settlement call"}
	}
	out.charged = c.charged
	if c.reached || errors.Is(failure, ErrLimit) {
		out.outcome = "limit"
	} else if failure != nil {
		if e, ok := failure.(*ScriptError); ok && e != nil {
			out.outcome = "fail"
			if err := b.encodeFailure(out, e); err != nil {
				out.hostError(err.Error())
			}
		} else {
			out.hostError(fmt.Sprint(failure))
		}
	} else if op.Mode == Suspending {
		out.outcome = "started"
	} else if op.Mode == FireAndForget {
		out.outcome = "done"
	} else {
		out.outcome = "result"
		if err := b.encodeResult(out, result); err != nil {
			out.hostError(err.Error())
		}
	}
	if out.outcome == "hostError" {
		b.failureDetails[c.id] = out.detail
	}
	if automatic {
		detail := "result violates its Shape or Group ownership"
		if failure != nil {
			detail = fmt.Sprint(failure)
		}
		if out.outcome == "hostError" {
			detail = out.detail
		}
		b.effectDetails[zigEffectKey(c.segmentID, "abandon", grantName, c.scopeName)] = detail
	}
	if op.Mode == Suspending && out.outcome != "started" {
		b.callsMu.Lock()
		delete(b.calls, c.id)
		b.callsMu.Unlock()
		cancel()
	}
	return nil
}

// The guest owns enrollment and finalization; bindings and hook identity stay
// in Go. Enrollment order comes from the need, including aliases.
func (b *zigGroup) effect(n *zigNeed, out *zigResult) error {
	s := b.group.Script(n.script)
	if s == nil {
		return fmt.Errorf("Zig effect names an unknown Script")
	}
	name := n.grant
	grant := s.grants[name]
	if grant == nil || grant.coordinator == nil {
		return fmt.Errorf("Zig effect names an unknown Coordinator")
	}
	grants := []SegmentGrant{}
	for _, gn := range n.grants {
		g := s.grants[gn]
		if g == nil || g.coordinator != grant.coordinator {
			return fmt.Errorf("Zig effect has inconsistent enrollment")
		}
		grants = append(grants, SegmentGrant{GrantName: gn, Binding: g.binding})
	}
	if n.nowErr != nil {
		return n.nowErr
	}
	ctx := SegmentContext{Group: b.group, ScriptName: s.name, RunID: RunID(n.run), GrantName: name, SegmentID: n.segment, Binding: grant.binding, Now: n.now, Grants: grants}
	var hook func(SegmentContext) EffectResult
	switch n.phase {
	case "begin":
		hook = grant.coordinator.Begin
	case "commit":
		hook = grant.coordinator.Commit
	case "rollback":
		hook = grant.coordinator.Rollback
	default:
		return fmt.Errorf("unknown Zig effect phase %q", n.phase)
	}
	result := invokeEffect(hook, ctx)
	if result.Status != EffectOK {
		b.effectDetails[zigEffectKey(ctx.SegmentID, n.phase, "", "")] = result.Detail
	}
	out.outcome, out.status = "status", string(result.Status)
	return nil
}

var zigPropertyNeedKeys = []string{"object", "prop", "value", "op"}

// A property crossing runs the public Get or Set with the Host's own handle.
// The guest has already charged, checked read-only and Set's Shape; it
// checks Get's result Shape after the reply.
func (b *zigGroup) property(n *zigNeed, out *zigResult) error {
	o, ok := (*Object)(nil), false
	if n.object {
		o, ok = b.resolve(n.objectKind, n.objectID)
	}
	if !ok {
		return fmt.Errorf("Zig property names an unknown Object")
	}
	if n.collection {
		return b.collection(n, o, out)
	}
	prop, ok := o.kind.props[n.prop]
	if !ok {
		return fmt.Errorf("Zig property names an undeclared property")
	}
	if n.set && n.valueErr != nil {
		return n.valueErr
	}
	result, failure := invokeProperty(prop, o, n.set, n.value)
	switch {
	case failure != nil:
		b.propertyFailure(failure, out)
	case n.set:
		out.outcome = "ok"
	default:
		out.outcome = "value"
		if err := b.encodeResult(out, result); err != nil {
			b.propertyHostError(err.Error(), out)
			return nil
		}
		if shape.Check(result.inner, prop.Shape.inner, nil) != nil {
			b.propertyDetails = append(b.propertyDetails, "result violates its Shape or Group ownership")
		}
	}
	return nil
}

// Host-only detail for the `call failed` report the guest may make; a
// property crossing has no Call id, so details are matched in order.
func (b *zigGroup) propertyHostError(detail string, out *zigResult) {
	b.propertyDetails = append(b.propertyDetails, detail)
	out.hostError(detail)
}

func (b *zigGroup) propertyFailure(failure error, out *zigResult) {
	if e, ok := failure.(*ScriptError); ok && e != nil {
		out.outcome = "fail"
		if err := b.encodeFailure(out, e); err != nil {
			b.propertyHostError(err.Error(), out)
			return
		}
		if detail := propertyFailureDetail(e); detail != "" {
			b.propertyDetails = append(b.propertyDetails, detail)
		}
		return
	}
	b.propertyHostError(fmt.Sprint(failure), out)
}

// collection answers an Object Collection callback (#1143): the `prop` need
// named `elements`, with its `op` and, for `at` and `find`, its `selector`.
// The guest has already charged and checked the selector; it checks the
// result after the reply.
func (b *zigGroup) collection(n *zigNeed, o *Object, out *zigResult) error {
	e := o.kind.elements
	if e == nil || n.prop != "elements" {
		return fmt.Errorf("Zig collection callback names an Object Kind without a collection")
	}
	if n.selected && n.valueErr != nil {
		return n.valueErr
	}
	selector := n.selector
	var invoke func() (Value, error)
	switch op := n.op; {
	case op == "count":
		invoke = func() (Value, error) { return e.Count(o) }
	case op == "at" && selector.inner.Kind == corevalue.Number:
		index, err := selector.inner.Number().Int64()
		if err != nil || index == 0 {
			return fmt.Errorf("Zig collection callback has an invalid position")
		}
		invoke = func() (Value, error) { return e.At(o, index) }
	case op == "find" && selector.inner.Kind == corevalue.Text:
		name := selector.inner.Text()
		invoke = func() (Value, error) { return e.Find(o, name) }
	default:
		return fmt.Errorf("Zig collection callback is malformed")
	}
	result, failure := func() (v Value, err error) {
		defer func() {
			if caught := recover(); caught != nil {
				err = fmt.Errorf("Host panic: %v", caught)
			}
		}()
		return invoke()
	}()
	if failure != nil {
		b.propertyFailure(failure, out)
		return nil
	}
	out.outcome = "value"
	if err := b.encodeResult(out, result); err != nil {
		b.propertyHostError(err.Error(), out)
	}
	return nil
}
