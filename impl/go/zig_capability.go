//go:build talk_zig_experimental

package northtalk

import (
	"fmt"
	"sort"

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
