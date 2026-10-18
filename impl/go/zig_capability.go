//go:build talk_zig_experimental

package northtalk

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/odogono/odgn-talk/impl/go/internal/shape"
)

// Declarations are mirrored into each guest, independently of their public
// names. Two definitions with the same name may have different implementations.
// Binding data stays in Go and is selected through the loaded named Grant.
func (b *zigGroup) grants(given map[string]*Grant) (map[string]any, map[string]*Grant, error) {
	out, kept := map[string]any{}, map[string]*Grant{}
	names := make([]string, 0, len(given))
	for name := range given {
		names = append(names, name)
	}
	sort.Strings(names)
	// Validate the whole attachment before installing any guest declarations.
	for _, name := range names {
		g := given[name]
		if g == nil || g.definition == nil {
			return nil, nil, &HostError{InvalidValue, "invalid Grant"}
		}
		if _, err := zigDeclaration(g.definition); err != nil {
			return nil, nil, err
		}
	}
	for _, name := range names {
		g := given[name]
		def := g.definition
		handle, err := b.reg.define(def, func(handle string) error {
			ops, _ := zigDeclaration(def)
			declaration := map[string]any{"name": def.name, "handle": handle, "ops": ops, "release": def.release != nil, "segmentLifecycle": zigSegmentBound(def)}
			if len(def.checks) != 0 {
				declaration["standard"] = def.name
			}
			_, err := b.send("define-capability", declaration)
			return err
		})
		if err != nil {
			return nil, nil, err
		}
		ops := make([]string, 0, len(g.operations))
		bound := g.named()
		for op := range g.operations {
			ops = append(ops, op)
			bound.operations[op] = true
		}
		sort.Strings(ops)
		fields := map[string]any{"capability": handle, "ops": ops}
		if zigSegmentBound(def) && bound.coordinator != nil {
			id, ok := b.coordinators[bound.coordinator]
			if !ok {
				id = fmt.Sprintf("go-coordinator-%d", len(b.coordinators)+1)
				b.coordinators[bound.coordinator] = id
			}
			fields["coordinator"] = id
		}
		if len(def.checks) != 0 {
			if def.name == "locale" {
				tag, ok := g.binding.(string)
				if !ok {
					tag = "und"
				}
				fields["locale"] = tag
			}
			if def.name == "sqlite" {
				binding, _ := sqliteBindingOf(g.binding)
				fields["maxRows"] = binding.MaxRows
			}
		}
		reply, err := b.send("grant", fields)
		if err != nil {
			return nil, nil, err
		}
		id, ok := reply.get("grant").int64()
		if !ok {
			return nil, nil, fmt.Errorf("Zig grant returned an invalid id")
		}
		out[name], kept[name] = id, bound
	}
	return out, kept, nil
}

func zigDeclaration(d *CapabilityDef) ([]any, error) {
	names := make([]string, 0, len(d.ops))
	for name := range d.ops {
		names = append(names, name)
	}
	sort.Strings(names)
	ops := make([]any, 0, len(names))
	for _, name := range names {
		op := d.ops[name]
		args := make([]any, len(op.Args))
		for i, arg := range op.Args {
			encoded, err := zigShape(arg.inner, 0)
			if err != nil {
				return nil, err
			}
			args[i] = encoded
		}
		fields := map[string]any{"name": name, "args": args, "mode": modeName(op.Mode), "cost": map[string]any{"fuel": op.Cost.Fuel, "alloc": op.Cost.Alloc}, "maxPending": op.MaxPending.Milliseconds()}
		if op.SegmentBound {
			fields["segmentBound"] = true
		}
		if op.Scope != nil {
			if op.Scope.Opens != "" {
				fields["scope"] = map[string]any{"opens": op.Scope.Opens, "abandon": op.Scope.Abandon}
			} else {
				fields["scope"] = map[string]any{"closes": op.Scope.Closes}
			}
		}
		if op.Command {
			fields["command"] = true
		}
		if op.Result.inner.Kind != "" {
			encoded, err := zigShape(op.Result.inner, 0)
			if err != nil {
				return nil, err
			}
			fields["result"] = encoded
		}
		if op.Errors != nil {
			decls := make([]any, len(op.Errors))
			for i, decl := range op.Errors {
				fs, err := zigShapeFields(decl.Fields)
				if err != nil {
					return nil, err
				}
				decls[i] = map[string]any{"code": decl.Code, "fields": fs}
			}
			fields["errors"] = decls
		}
		ops = append(ops, fields)
	}
	return ops, nil
}
func zigShapeFields(fields []Field) ([]any, error) {
	out := make([]any, len(fields))
	for i, f := range fields {
		s, err := zigShape(f.Shape.inner, 0)
		if err != nil {
			return nil, err
		}
		out[i] = map[string]any{"key": f.Key, "shape": s, "optional": f.Optional}
	}
	return out, nil
}
func zigShape(s shape.Shape, depth int) (any, error) {
	if depth > 32 {
		return nil, backendUnsupported("Shapes nested beyond 32 levels")
	}
	switch s.Kind {
	case "any", "value":
		return s.Kind, nil
	case "kind":
		return s.Name, nil
	case "object":
		return map[string]any{"object": s.Name}, nil
	case "quantity", "unitKind":
		return map[string]any{s.Kind: s.Name}, nil
	case "list", "optional":
		inner, err := zigShape(s.Of[0], depth+1)
		return map[string]any{s.Kind: inner}, err
	case "oneOf":
		out := make([]any, len(s.Of))
		for i, inner := range s.Of {
			v, err := zigShape(inner, depth+1)
			if err != nil {
				return nil, err
			}
			out[i] = v
		}
		return map[string]any{"oneOf": out}, nil
	case "map":
		fields := make([]any, len(s.Fields))
		for i, f := range s.Fields {
			v, err := zigShape(f.Shape, depth+1)
			if err != nil {
				return nil, err
			}
			fields[i] = map[string]any{"key": f.Key, "shape": v, "optional": f.Optional}
		}
		return map[string]any{"map": fields, "open": s.Open}, nil
	default:
		return nil, backendUnsupported("Shape " + s.Kind)
	}
}

func (b *zigGroup) callback(need zigReply) (map[string]any, error) {
	kind := zigText(need.get("m"))
	if kind == "trace" {
		return map[string]any{}, nil
	}
	if kind == "resolve" {
		return b.restoreBindings(need)
	}
	if kind == "prop" {
		return b.property(need)
	}
	if kind == "effect" {
		return b.effect(need)
	}
	if kind != "op" && kind != "release" {
		return nil, backendUnsupported("Host callback " + kind)
	}
	s := b.group.Script(zigText(need.get("script")))
	if s == nil {
		return nil, fmt.Errorf("Zig callback names an unknown Script")
	}
	grantName := zigText(need.get("grant"))
	grant := s.grants[grantName]
	if grant == nil {
		return nil, fmt.Errorf("Zig callback names an unknown Grant")
	}
	if kind == "release" {
		if grant.definition.release == nil {
			return nil, fmt.Errorf("Zig release names a Grant without a release hook")
		}
		now, err := time.Parse(time.RFC3339Nano, zigText(need.get("now")))
		if err != nil {
			return nil, err
		}
		reason := ReleaseReason(zigText(need.get("reason")))
		switch reason {
		case ReleaseStop, ReleaseReload, ReleaseRevoke, ReleaseDisable:
		default:
			return nil, fmt.Errorf("unknown Zig Grant release reason %q", reason)
		}
		invokeReleaseHook(grant.definition.release, GrantContext{Group: b.group, ScriptName: s.name, GrantName: grantName, Binding: grant.binding, Now: now, Reason: reason})
		return map[string]any{}, nil
	}
	name := zigText(need.get("operation"))
	op, ok := grant.definition.ops[name]
	if !ok || !grant.operations[name] || zigText(need.get("capability")) != b.reg.handle(grant.definition) {
		return nil, fmt.Errorf("Zig callback does not match its Grant")
	}
	var args []Value
	for _, raw := range need.get("args").items() {
		v, err := b.decodeValue(raw)
		if err != nil {
			detail := err.Error()
			b.failureDetails[CallID(zigText(need.get("call")))] = detail
			return map[string]any{"hostError": detail}, nil
		}
		args = append(args, v)
	}
	now, err := time.Parse(time.RFC3339Nano, zigText(need.get("now")))
	if err != nil {
		return nil, err
	}
	ctx, cancel := operationContext(op.Mode)
	automatic, _ := need.get("automatic").boolean()
	if automatic {
		ctx = context.Background()
	}
	c := &Call{automatic: automatic, scopeName: zigText(need.get("scope")), group: b.group, scriptName: s.name, runID: RunID(zigText(need.get("run"))), grantName: grantName, binding: grant.binding, id: CallID(zigText(need.get("call"))), segmentID: zigText(need.get("segment")), now: now, context: ctx, starting: true}
	var left int64
	limited := need.get("fuelLeft").present()
	if limited {
		var ok bool
		if left, ok = need.get("fuelLeft").int64(); !ok {
			return nil, fmt.Errorf("Zig callback has an invalid fuelLeft")
		}
	}
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
	result, failure := invokeOperation(op, c, args)
	c.finish()
	if c.invalidAutomatic {
		failure = &HostError{InvalidValue, "automatic abandonment attempted a budget or settlement call"}
	}
	out := map[string]any{}
	if c.charged != 0 {
		out["charged"] = c.charged
	}
	if c.reached || errors.Is(failure, ErrLimit) {
		out["limit"] = true
	} else if failure != nil {
		if e, ok := failure.(*ScriptError); ok && e != nil {
			encoded, err := b.zigScriptFailure(e)
			if err != nil {
				out["hostError"] = err.Error()
			} else {
				out["fail"] = encoded
			}
		} else {
			out["hostError"] = fmt.Sprint(failure)
		}
	} else if op.Mode == Suspending {
		out["started"] = true
	} else if op.Mode == FireAndForget {
		out["done"] = true
	} else {
		encoded, err := b.zigEncoded(result)
		if err != nil {
			out["hostError"] = err.Error()
		} else {
			out["result"] = encoded
		}
	}
	if detail, ok := out["hostError"].(string); ok {
		b.failureDetails[c.id] = detail
	}
	if automatic {
		detail := "result violates its Shape or Group ownership"
		if failure != nil {
			detail = fmt.Sprint(failure)
		}
		if host, ok := out["hostError"].(string); ok {
			detail = host
		}
		b.effectDetails[zigEffectKey(c.segmentID, "abandon", grantName, c.scopeName)] = detail
	}
	if op.Mode == Suspending && out["started"] == nil {
		b.callsMu.Lock()
		delete(b.calls, c.id)
		b.callsMu.Unlock()
		cancel()
	}
	return out, nil
}
func (b *zigGroup) abandoned(ids zigReply) {
	for _, raw := range ids.items() {
		b.abandonedIDs([]string{zigText(raw)})
	}
}

func (b *zigGroup) abandonedIDs(ids []string) {
	for _, raw := range ids {
		id := CallID(raw)
		b.callsMu.Lock()
		cancel := b.calls[id]
		delete(b.calls, id)
		b.callsMu.Unlock()
		if cancel != nil {
			cancel()
		}
	}
}

// The Core distinguishes a queued answer from one actually consumed. In
// particular a sliced ready Run can still be cancelled before resumption.
func (b *zigGroup) settled(ids zigReply) {
	if !ids.present() {
		return
	}
	var texts []string
	for _, raw := range ids.items() {
		texts = append(texts, zigText(raw))
	}
	b.settledIDs(texts)
}

func (b *zigGroup) settledIDs(ids []string) {
	b.callsMu.Lock()
	defer b.callsMu.Unlock()
	for _, id := range ids {
		delete(b.calls, CallID(id))
	}
}
func (b *zigGroup) settleCall(c *Call, kind string, v Value, e *ScriptError, fuel int64) {
	fields := map[string]any{"call": string(c.id)}
	if kind == "answer" {
		encoded, err := b.zigEncoded(v)
		if err != nil {
			panic(err)
		}
		fields["value"], fields["fuel"] = encoded, fuel
	} else if e != nil {
		encoded, err := b.zigScriptFailure(e)
		if err != nil {
			panic(err)
		}
		// An envelope collision is a malformed failure, retained as a broken
		// settlement until resumption. Its input Trace must still contain a map.
		if len(hostFailureValue(e).Entries()) != 0 {
			fields["error"] = encoded
		}
	}
	if _, err := b.send(kind, fields); err != nil {
		panic(err)
	}
	b.ready()
}

func (b *zigGroup) grantNames(s *Script) map[string][]string {
	reply, err := b.worker("grants", map[string]any{"script": s.name})
	if err != nil {
		panic(err)
	}
	out := map[string][]string{}
	for _, entry := range reply.entries() {
		items := entry.Val.items()
		ops := make([]string, len(items))
		for i, op := range items {
			ops[i] = zigText(op)
		}
		out[entry.Key] = ops
	}
	return out
}

// The guest owns enrollment and finalization; bindings and hook identity stay
// in Go. Enrollment order comes from the need, including aliases.
func (b *zigGroup) effect(need zigReply) (map[string]any, error) {
	s := b.group.Script(zigText(need.get("script")))
	if s == nil {
		return nil, fmt.Errorf("Zig effect names an unknown Script")
	}
	name := zigText(need.get("grant"))
	grant := s.grants[name]
	if grant == nil || grant.coordinator == nil {
		return nil, fmt.Errorf("Zig effect names an unknown Coordinator")
	}
	grants := []SegmentGrant{}
	for _, raw := range need.get("grants").items() {
		n := zigText(raw)
		g := s.grants[n]
		if g == nil || g.coordinator != grant.coordinator {
			return nil, fmt.Errorf("Zig effect has inconsistent enrollment")
		}
		grants = append(grants, SegmentGrant{GrantName: n, Binding: g.binding})
	}
	now, err := time.Parse(time.RFC3339Nano, zigText(need.get("now")))
	if err != nil {
		return nil, err
	}
	ctx := SegmentContext{Group: b.group, ScriptName: s.name, RunID: RunID(zigText(need.get("run"))), GrantName: name, SegmentID: zigText(need.get("segment")), Binding: grant.binding, Now: now, Grants: grants}
	var hook func(SegmentContext) EffectResult
	phase := zigText(need.get("phase"))
	switch phase {
	case "begin":
		hook = grant.coordinator.Begin
	case "commit":
		hook = grant.coordinator.Commit
	case "rollback":
		hook = grant.coordinator.Rollback
	default:
		return nil, fmt.Errorf("unknown Zig effect phase %q", phase)
	}
	result := invokeEffect(hook, ctx)
	if result.Status != EffectOK {
		b.effectDetails[zigEffectKey(ctx.SegmentID, phase, "", "")] = result.Detail
	}
	return map[string]any{"status": string(result.Status)}, nil
}

func (b *zigGroup) effectDetail(e *EffectFailure) string {
	return b.effectDetails[zigEffectKey(e.Segment, e.Phase, e.Grant, e.Scope)]
}

// zigEffectKey identifies an effect failure's detail; only abandonment is per Grant and Scope.
func zigEffectKey(segment, phase, grant, scope string) string {
	if phase != "abandon" {
		return segment + "/" + phase
	}
	return segment + "/" + phase + "/" + grant + "/" + scope
}

func zigSegmentBound(d *CapabilityDef) bool {
	for _, op := range d.ops {
		if op.SegmentBound {
			return true
		}
	}
	return false
}
