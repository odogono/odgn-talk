//go:build talk_zig_experimental

package northtalk

import (
	"encoding/json"
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
		handle, exists := b.definitions[def]
		if !exists {
			handle = fmt.Sprintf("go-capability-%d", len(b.definitions)+1)
			ops, _ := zigDeclaration(def)
			if _, err := b.send("define-capability", map[string]any{"name": handle, "ops": ops}); err != nil {
				return nil, nil, err
			}
			b.definitions[def] = handle
		}
		ops := make([]string, 0, len(g.operations))
		bound := g.named()
		for op := range g.operations {
			ops = append(ops, op)
			bound.operations[op] = true
		}
		sort.Strings(ops)
		reply, err := b.send("grant", map[string]any{"capability": handle, "ops": ops})
		if err != nil {
			return nil, nil, err
		}
		n, _ := reply.Get("grant").AsDec()
		id, err := n.Int64()
		if err != nil {
			return nil, nil, err
		}
		out[name], kept[name] = id, bound
	}
	return out, kept, nil
}

func zigDeclaration(d *CapabilityDef) ([]any, error) {
	if d.release != nil || d.lifecycle != nil || d.coordinate != nil {
		return nil, backendUnsupported("Capability lifecycle and release hooks")
	}
	if len(d.checks) != 0 {
		return nil, backendUnsupported("Standard Capability refinements")
	}
	names := make([]string, 0, len(d.ops))
	for name := range d.ops {
		names = append(names, name)
	}
	sort.Strings(names)
	ops := make([]any, 0, len(names))
	for _, name := range names {
		op := d.ops[name]
		if op.Scope != nil || op.SegmentBound || op.Mode == FireAndForget {
			return nil, backendUnsupported("scoped, Segment-bound and fire-and-forget Operations")
		}
		args := make([]any, len(op.Args))
		for i, arg := range op.Args {
			encoded, err := zigShape(arg.inner, 0)
			if err != nil {
				return nil, err
			}
			args[i] = encoded
		}
		fields := map[string]any{"name": name, "args": args, "mode": modeName(op.Mode), "cost": map[string]any{"fuel": op.Cost.Fuel, "alloc": op.Cost.Alloc}, "maxPending": op.MaxPending.Milliseconds()}
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
		if s.Name == "function" {
			return nil, backendUnsupported("Function Shapes")
		}
		return s.Name, nil
	case "object":
		return nil, backendUnsupported("Object Shapes")
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

func zigEncoded(v Value) (json.RawMessage, error) {
	if err := zigDataOnly(v); err != nil {
		return nil, err
	}
	raw, err := EncodeValue(v)
	return json.RawMessage(raw), err
}
func zigScriptFailure(e *ScriptError) (map[string]any, error) {
	data, err := zigEncoded(e.Data)
	if err != nil {
		return nil, err
	}
	out := map[string]any{"code": e.Code, "data": data}
	if e.Message != "" {
		out["message"] = e.Message
	}
	return out, nil
}

func (b *zigGroup) callback(need Value) (map[string]any, error) {
	if zigText(need.Get("m")) == "trace" {
		return map[string]any{}, nil
	}
	if zigText(need.Get("m")) != "op" {
		return nil, backendUnsupported("Host callback " + zigText(need.Get("m")))
	}
	s := b.group.Script(zigText(need.Get("script")))
	if s == nil {
		return nil, fmt.Errorf("Zig callback names an unknown Script")
	}
	grantName := zigText(need.Get("grant"))
	grant := s.grants[grantName]
	if grant == nil {
		return nil, fmt.Errorf("Zig callback names an unknown Grant")
	}
	name := zigText(need.Get("operation"))
	op, ok := grant.definition.ops[name]
	if !ok || !grant.operations[name] || zigText(need.Get("capability")) != b.definitions[grant.definition] {
		return nil, fmt.Errorf("Zig callback does not match its Grant")
	}
	var args []Value
	for i := 1; i <= need.Get("args").Len(); i++ {
		raw, err := EncodeJSON(need.Get("args").Index(i))
		if err != nil {
			return nil, err
		}
		v, err := DecodeValue(raw, nil)
		if err != nil {
			detail := backendUnsupported("Function and Object callback arguments").Error()
			b.failureDetails[CallID(zigText(need.Get("call")))] = detail
			return map[string]any{"hostError": detail}, nil
		}
		args = append(args, v)
	}
	now, err := time.Parse(time.RFC3339Nano, zigText(need.Get("now")))
	if err != nil {
		return nil, err
	}
	ctx, cancel := operationContext(op.Mode)
	c := &Call{group: b.group, scriptName: s.name, runID: RunID(zigText(need.Get("run"))), grantName: grantName, binding: grant.binding, id: CallID(zigText(need.Get("call"))), segmentID: zigText(need.Get("segment")), now: now, context: ctx, starting: true}
	var left int64
	limited := need.Get("fuelLeft").Kind() != KindNothing
	if limited {
		n, _ := need.Get("fuelLeft").AsDec()
		left, err = n.Int64()
		if err != nil {
			return nil, err
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
	out := map[string]any{}
	if c.charged != 0 {
		out["charged"] = c.charged
	}
	if c.reached || errors.Is(failure, ErrLimit) {
		out["limit"] = true
	} else if failure != nil {
		if e, ok := failure.(*ScriptError); ok && e != nil {
			encoded, err := zigScriptFailure(e)
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
	} else {
		encoded, err := zigEncoded(result)
		if err != nil {
			out["hostError"] = err.Error()
		} else {
			out["result"] = encoded
		}
	}
	if detail, ok := out["hostError"].(string); ok {
		b.failureDetails[c.id] = detail
	}
	if op.Mode == Suspending && out["started"] == nil {
		b.callsMu.Lock()
		delete(b.calls, c.id)
		b.callsMu.Unlock()
		cancel()
	}
	return out, nil
}
func (b *zigGroup) abandoned(ids Value) {
	for i := 1; i <= ids.Len(); i++ {
		id := CallID(zigText(ids.Index(i)))
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
func (b *zigGroup) settled(ids Value) {
	b.callsMu.Lock()
	defer b.callsMu.Unlock()
	for i := 1; i <= ids.Len(); i++ {
		delete(b.calls, CallID(zigText(ids.Index(i))))
	}
}
func (b *zigGroup) settleCall(c *Call, kind string, v Value, e *ScriptError, fuel int64) {
	fields := map[string]any{"call": string(c.id)}
	if kind == "answer" {
		encoded, err := zigEncoded(v)
		if err != nil {
			panic(err)
		}
		fields["value"], fields["fuel"] = encoded, fuel
	} else if e != nil {
		encoded, err := zigScriptFailure(e)
		if err != nil {
			panic(err)
		}
		fields["error"] = encoded
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
	for _, entry := range reply.Entries() {
		ops := make([]string, entry.Val.Len())
		for i := range ops {
			ops[i] = zigText(entry.Val.Index(i + 1))
		}
		out[entry.Key] = ops
	}
	return out
}
