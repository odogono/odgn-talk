package northtalk

import (
	"context"
	"errors"
	"fmt"
	"os"
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
var (
	zbOpResult      = zbTagFor("op-result")
	zbPropResult    = zbTagFor("prop-result")
	zbEffectResult  = zbTagFor("effect-result")
	zbReleaseResult = zbTagFor("release-result")
	zbOpNeed        = zbTagFor("op")
	zbPropNeed      = zbTagFor("prop")
	zbEffectNeed    = zbTagFor("effect")
)

// zigNeed is a callback need read from either envelope. Decoding failures
// are kept, so each is refused at the point the JSON reader always refused it.
type zigNeed struct {
	// tag is zero for JSON, otherwise the binary need tag used by its result writer.
	tag                                                byte
	bindGrants, bindObjects                            [][2]string
	kind                                               string
	script, grant, reason, operation, capability, call string
	scope, run, segment, phase, delivery               string
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
	w.begin(zbEnvelopes[tag].fields, true)
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

// callback answers a decoded need in the envelope it arrived in.
func (b *zigGroup) callback(n *zigNeed) (map[string]any, *zbFrame, error) {
	switch n.kind {
	case "trace":
		return map[string]any{}, nil, nil
	case "resolve":
		fields, err := b.restoreBindings(n)
		return fields, nil, err
	case "op", "release", "prop", "effect":
	default:
		return nil, nil, backendUnsupported("Host callback " + n.kind)
	}
	r, err := b.answer(n, n.tag != 0)
	if err != nil {
		return nil, nil, err
	}
	if n.tag != 0 {
		return map[string]any{}, b.zbResult(n.tag, &r), nil
	}
	return r.fields(), nil, nil
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
	c := &Call{automatic: automatic, delivery: n.delivery, scopeName: n.scope, group: b.group, scriptName: s.name, runID: RunID(n.run), grantName: grantName, binding: grant.binding, id: CallID(n.call), segmentID: n.segment, now: n.now, context: ctx, starting: true}
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
