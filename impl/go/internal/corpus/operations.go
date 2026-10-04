package corpus

import (
	"fmt"
	talk "github.com/odogono/odgn-talk/impl/go"
	"strconv"
	"time"
)

type operationReplay struct {
	calls        map[talk.CallID]*talk.Call
	defs         map[string]*talk.CapabilityDef
	stubs        map[string][]map[string]Field
	declarations talk.GrantDecls
}

func setupOperations(core *talk.Core, setup Setup) (*operationReplay, error) {
	out := &operationReplay{calls: map[talk.CallID]*talk.Call{}, defs: map[string]*talk.CapabilityDef{}, stubs: map[string][]map[string]Field{}, declarations: talk.GrantDecls{}}
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
			return out.invoke(key, op.Mode, c)
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
	// Console is available only for load diagnostics until its factory is implemented.
	standards, _ := setup["standard"].([]any)
	seen := map[string]bool{}
	for _, raw := range standards {
		row := raw.(Setup)
		name := row["capability"].(string)
		if seen[name] || len(byName[name]) > 0 {
			return nil, &talk.HostError{Code: talk.InvalidValue, Detail: "duplicate Standard Capability"}
		}
		seen[name] = true
		var names []string
		switch name {
		case "clock":
			names = []string{"now"}
		case "timer":
			names = []string{"schedule", "cancel"}
		}
		costs, costErr := setupStandardCosts(row, names)
		if costErr != nil {
			return nil, costErr
		}
		var def *talk.CapabilityDef
		var err error
		switch name {
		case "clock":
			def, err = core.ClockCapability(costs)
			out.declarations[name] = map[string]talk.OperationCheck{"now": {Mode: talk.Immediate}}
		case "timer":
			def, err = core.TimerCapability(replayTimer{out}, costs)
			out.declarations[name] = map[string]talk.OperationCheck{
				"schedule": {Mode: talk.FireAndForget, Args: []talk.Shape{talk.TextShape, talk.InstantShape, talk.TextShape, talk.ListOf(talk.AnyShape)}},
				"cancel":   {Mode: talk.FireAndForget, Args: []talk.Shape{talk.TextShape}},
			}
		case "console":
			byName[name] = []talk.Operation{
				{Name: "write", Mode: talk.FireAndForget, Args: []talk.Shape{talk.ValueShape}, Fire: func(*talk.Call, []talk.Value) error { return nil }},
				{Name: "read", Mode: talk.Suspending, Result: talk.TextShape, Start: func(*talk.Call, []talk.Value) error { return nil }},
			}
		default:
			return nil, fmt.Errorf("unsupported Standard Capability %s", name)
		}
		if err != nil {
			return nil, err
		}
		if def != nil {
			out.defs[name] = def
		}
	}
	for name, ops := range byName {
		out.declarations[name] = map[string]talk.OperationCheck{}
		for _, op := range ops {
			out.declarations[name][op.Name] = talk.OperationCheck{Mode: op.Mode, Args: op.Args}
		}
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

// Standard Timer replay consumes ordinary fire-and-forget Stubs. Cases supply
// due Deliveries explicitly; the runner stores no durable timers.
type replayTimer struct{ replay *operationReplay }

func (t replayTimer) Schedule(c *talk.Call, name string, at talk.Value, message string, args talk.Value) error {
	_, err := t.replay.invoke("timer.schedule", talk.FireAndForget, c)
	return err
}
func (t replayTimer) Cancel(c *talk.Call, name string) error {
	_, err := t.replay.invoke("timer.cancel", talk.FireAndForget, c)
	return err
}
func (o *operationReplay) invoke(key string, mode talk.Mode, c *talk.Call) (talk.Value, error) {
	queue := o.stubs[key]
	if len(queue) == 0 {
		if mode == talk.FireAndForget {
			return talk.Nothing, nil
		}
		return talk.Nothing, fmt.Errorf("missing Stub for %s", key)
	}
	stub := queue[0]
	o.stubs[key] = queue[1:]
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

func setupStandardCosts(row Setup, names []string) (talk.Costs, error) {
	costs := talk.Costs{}
	rows, _ := row["costs"].(Setup)
	for _, name := range names {
		raw, present := rows[name]
		if !present {
			continue
		} // The public factory refuses missing Operation entries.
		cost, ok := raw.(Setup)
		if !ok {
			return nil, &talk.HostError{Code: talk.InvalidValue, Detail: "invalid Standard Capability cost"}
		}
		var components [2]int64
		for i, key := range []string{"fuel", "alloc"} {
			if raw, present := cost[key]; present {
				component, ok := raw.(int64)
				if !ok {
					return nil, &talk.HostError{Code: talk.InvalidValue, Detail: "invalid Standard Capability cost component"}
				}
				components[i] = component
			}
		}
		costs[name] = talk.Cost{Fuel: components[0], Alloc: components[1]}
	}
	return costs, nil
}
