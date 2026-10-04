package corpus

import (
	"fmt"
	talk "github.com/odogono/odgn-talk/impl/go"
	"strconv"
	"time"
)

type operationReplay struct {
	calls map[talk.CallID]*talk.Call
	defs  map[string]*talk.CapabilityDef
	stubs map[string][]map[string]Field
}

func setupOperations(core *talk.Core, setup Setup) (*operationReplay, error) {
	out := &operationReplay{calls: map[talk.CallID]*talk.Call{}, defs: map[string]*talk.CapabilityDef{}, stubs: map[string][]map[string]Field{}}
	byName := map[string][]talk.Operation{}
	rawOps, _ := setup["operations"].([]any)
	for _, raw := range rawOps {
		row := raw.(Setup)
		name := row["capability"].(string)
		op := talk.Operation{Name: row["name"].(string)}
		switch row["mode"] {
		case "immediate":
			op.Mode = talk.Immediate
		case "suspending":
			op.Mode = talk.Suspending
		case "fire-and-forget":
			op.Mode = talk.FireAndForget
		default:
			return nil, fmt.Errorf("invalid mode")
		}
		args, _ := row["args"].([]any)
		for _, arg := range args {
			s, e := setupShape(arg)
			if e != nil {
				return nil, e
			}
			op.Args = append(op.Args, s)
		}
		if raw, ok := row["result"]; ok {
			s, e := setupShape(raw)
			if e != nil {
				return nil, e
			}
			op.Result = s
		}
		if cost, ok := row["cost"].(Setup); ok {
			op.Cost.Fuel, _ = cost["fuel"].(int64)
			op.Cost.Alloc, _ = cost["alloc"].(int64)
		}
		if raw, ok := row["errors"].([]any); ok {
			op.Errors = []talk.ErrorDecl{}
			for _, entry := range raw {
				e := entry.(Setup)
				op.Errors = append(op.Errors, talk.ErrorDecl{Code: e["code"].(string)})
			}
		}
		if ms, ok := row["maxPending"].(int64); ok {
			op.MaxPending = time.Duration(ms) * time.Millisecond
		}
		key := name + "." + op.Name
		invoke := func(c *talk.Call, args []talk.Value) (talk.Value, error) {
			queue := out.stubs[key]
			if len(queue) == 0 {
				if op.Mode == talk.FireAndForget {
					return talk.Nothing, nil
				}
				return talk.Nothing, fmt.Errorf("missing Stub for %s", key)
			}
			stub := queue[0]
			out.stubs[key] = queue[1:]
			if charge, ok := stub["charge"]; ok {
				n, _ := strconv.ParseInt(charge.Raw, 10, 64)
				if e := c.Charge(n); e != nil {
					return talk.Nothing, e
				}
			}
			if failed, ok := stub["error"]; ok {
				v := failed.Value
				code := v.Get("code")
				if code.Text == "" {
					return talk.Nothing, fmt.Errorf("Stub is not a ScriptError")
				}
				var entries []talk.Pair
				for _, p := range v.Entries {
					if p.Key != "code" && p.Key != "message" {
						x, e := construct(p.Val)
						if e != nil {
							return talk.Nothing, e
						}
						entries = append(entries, talk.KV(p.Key, x))
					}
				}
				data, _ := talk.Map(entries...)
				return talk.Nothing, &talk.ScriptError{Code: code.Text, Message: v.Get("message").Text, Data: data}
			}
			if value, ok := stub["value"]; ok {
				return construct(value.Value)
			}
			return talk.Nothing, nil
		}
		switch op.Mode {
		case talk.Immediate:
			op.Do = invoke
		case talk.FireAndForget:
			op.Fire = func(c *talk.Call, args []talk.Value) error { _, e := invoke(c, args); return e }
		case talk.Suspending:
			op.Start = func(c *talk.Call, args []talk.Value) error {
				out.calls[c.ID()] = c
				if len(out.stubs[key]) > 0 {
					_, err := invoke(c, args)
					return err
				}
				return nil
			}
		}
		byName[name] = append(byName[name], op)
	}
	// The console load-diagnostic fixture needs its fixed declarations. Runtime
	// Standard Capability factories remain outside this ordinary-Operation slice.
	standards, _ := setup["standard"].([]any)
	for _, raw := range standards {
		row := raw.(Setup)
		if row["capability"] == "console" {
			byName["console"] = []talk.Operation{
				{Name: "write", Mode: talk.FireAndForget, Args: []talk.Shape{talk.ValueShape}, Fire: func(*talk.Call, []talk.Value) error { return nil }},
				{Name: "read", Mode: talk.Suspending, Result: talk.TextShape, Start: func(*talk.Call, []talk.Value) error { return nil }},
			}
		}
	}
	for name, ops := range byName {
		d, e := core.DefineCapability(name, ops...)
		if e != nil {
			return nil, e
		}
		out.defs[name] = d
	}
	return out, nil
}
func (o *operationReplay) grants(setup Setup) (map[string]*talk.Grant, error) {
	out := map[string]*talk.Grant{}
	grants, _ := setup["grants"].(Setup)
	for name, raw := range grants {
		row := raw.(Setup)
		defName := name
		if n, ok := row["capability"].(string); ok {
			defName = n
		}
		d := o.defs[defName]
		if d == nil {
			return nil, fmt.Errorf("unknown Capability %s", defName)
		}
		if row["ops"] == "all" {
			out[name] = d.GrantAll(row["binding"])
			continue
		}
		var ops []string
		for _, op := range row["ops"].([]any) {
			ops = append(ops, op.(string))
		}
		g, e := d.Grant(ops, row["binding"])
		if e != nil {
			return nil, e
		}
		out[name] = g
	}
	return out, nil
}
func setupShape(raw any) (talk.Shape, error) {
	if name, ok := raw.(string); ok {
		shapes := map[string]talk.Shape{"any": talk.AnyShape, "value": talk.ValueShape, "nothing": talk.NothingShape, "boolean": talk.BoolShape, "number": talk.NumberShape, "text": talk.TextShape, "bytes": talk.BytesShape, "instant": talk.InstantShape, "range": talk.RangeShape, "civil date": talk.CivilDateShape, "pattern": talk.PatternShape, "function": talk.FunctionShape}
		if s, ok := shapes[name]; ok {
			return s, nil
		}
		return talk.Shape{}, fmt.Errorf("unknown Shape %s", name)
	}
	m := raw.(Setup)
	if x, ok := m["quantity"].(string); ok {
		return talk.QuantityOf(x), nil
	}
	if x, ok := m["unitKind"].(string); ok {
		return talk.QuantityKind(x), nil
	}
	for _, key := range []string{"optional", "list"} {
		if x, ok := m[key]; ok {
			s, e := setupShape(x)
			if e != nil {
				return s, e
			}
			if key == "optional" {
				return talk.Optional(s), nil
			}
			return talk.ListOf(s), nil
		}
	}
	if xs, ok := m["oneOf"].([]any); ok {
		var ss []talk.Shape
		for _, x := range xs {
			s, e := setupShape(x)
			if e != nil {
				return s, e
			}
			ss = append(ss, s)
		}
		return talk.OneOf(ss...), nil
	}
	for _, key := range []string{"map", "openMap"} {
		if xs, ok := m[key].([]any); ok {
			var fields []talk.Field
			for _, x := range xs {
				f := x.(Setup)
				s, e := setupShape(f["shape"])
				if e != nil {
					return s, e
				}
				optional, _ := f["optional"].(bool)
				fields = append(fields, talk.Field{Key: f["key"].(string), Shape: s, Optional: optional})
			}
			if key == "map" && m["open"] != true {
				return talk.MapShape(fields...), nil
			}
			return talk.OpenMap(fields...), nil
		}
	}
	return talk.Shape{}, fmt.Errorf("unsupported Shape %v", raw)
}
