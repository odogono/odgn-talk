package corpus

import (
	"fmt"
	talk "github.com/odogono/odgn-talk/impl/go"
	"strconv"
	"time"
)

type operationReplay struct {
	crossing     func(string)
	values       *replayValues
	calls        map[talk.CallID]*talk.Call
	defs         map[string]*talk.CapabilityDef
	stubs        map[string][]map[string]Field
	effectStubs  map[string][]map[string]Field
	declarations talk.GrantDecls
	// strict makes a missing lifecycle Stub a malformed case, as in the TS
	// replay Host, rather than an unknown outcome.
	strict    bool
	malformed error
	// coordinators holds each case `coordinator` name's Segment Coordinator;
	// coordinator is the name of the Grant being created.
	coordinators map[string]*talk.SegmentLifecycle
	coordinator  string
}

func setupOperations(core *talk.Core, setup Setup) (*operationReplay, error) {
	out := &operationReplay{values: newReplayValues(), calls: map[talk.CallID]*talk.Call{}, defs: map[string]*talk.CapabilityDef{}, stubs: map[string][]map[string]Field{}, declarations: talk.GrantDecls{}}
	out.effectStubs = map[string][]map[string]Field{}
	out.coordinators = map[string]*talk.SegmentLifecycle{}
	byName := map[string][]talk.Operation{}
	rawOps, _ := setup["operations"].([]any)
	for _, raw := range rawOps {
		row := raw.(Setup)
		name := row["capability"].(string)
		op := talk.Operation{Name: row["name"].(string)}
		op.SegmentBound, _ = row["segmentBound"].(bool)
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
		if scope, ok := row["scope"].(Setup); ok {
			op.Scope = &talk.ScopeDecl{}
			op.Scope.Opens, _ = scope["opens"].(string)
			op.Scope.Closes, _ = scope["closes"].(string)
			op.Scope.Abandon, _ = scope["abandon"].(string)
		}
		key := name + "." + op.Name
		invoke := func(c *talk.Call, args []talk.Value) (talk.Value, error) {
			for _, arg := range args {
				out.values.receive(arg)
			}
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
				for _, arg := range args {
					out.values.receive(arg)
				}
				if len(out.stubs[key]) > 0 {
					_, err := invoke(c, args)
					return err
				}
				if out.crossing != nil {
					out.crossing(string(c.ID()))
				}
				return nil
			}
		}
		byName[name] = append(byName[name], op)
	}
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
		case "console":
			names = []string{"write", "read"}
		case "calendar":
			names = []string{"today", "now", "toCivil", "toInstant", "offset", "zone"}
		case "store":
			names = []string{"get", "set", "delete", "keys", "increment", "swap"}
		case "sqlite":
			names = []string{"query", "change", "begin", "commit", "rollback"}
		case "locale":
			names = []string{"compare", "rank", "upper", "lower", "numberSymbols", "monthNames", "dayNames", "tag"}
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
			def, err = core.ConsoleCapability(replayConsole{out}, costs)
			out.declarations[name] = map[string]talk.OperationCheck{
				"write": {Mode: talk.FireAndForget, Args: []talk.Shape{talk.ValueShape}},
				"read":  {Mode: talk.Suspending},
			}
		case "calendar":
			def, err = core.CalendarCapability(replayCalendar{out}, costs)
			optionalText := talk.Optional(talk.TextShape)
			out.declarations[name] = map[string]talk.OperationCheck{
				"today":     {Mode: talk.Immediate, Args: []talk.Shape{optionalText}},
				"now":       {Mode: talk.Immediate, Args: []talk.Shape{optionalText}},
				"toCivil":   {Mode: talk.Immediate, Args: []talk.Shape{talk.InstantShape, optionalText}},
				"toInstant": {Mode: talk.Immediate, Args: []talk.Shape{talk.CivilDateShape, optionalText, optionalText}},
				"offset":    {Mode: talk.Immediate, Args: []talk.Shape{talk.InstantShape, optionalText}},
				"zone":      {Mode: talk.Immediate, Args: []talk.Shape{optionalText}},
			}
		case "store":
			def, err = core.StoreCapability(replayStore{out}, costs)
			// A Script Load rechecks imported calls against the factory's exact
			// number-or-Quantity Shape; there is no public any-Quantity Shape.
			out.declarations[name] = map[string]talk.OperationCheck{
				"get":       {Mode: talk.Immediate, Args: []talk.Shape{talk.TextShape, talk.Optional(talk.AnyShape)}},
				"set":       {Mode: talk.Immediate, Args: []talk.Shape{talk.TextShape, talk.AnyShape}},
				"delete":    {Mode: talk.Immediate, Args: []talk.Shape{talk.TextShape}},
				"keys":      {Mode: talk.Immediate, Args: []talk.Shape{talk.Optional(talk.TextShape)}},
				"increment": {Mode: talk.Immediate, Args: []talk.Shape{talk.TextShape, talk.Optional(talk.AnyShape)}},
				"swap":      {Mode: talk.Immediate, Args: []talk.Shape{talk.TextShape, talk.AnyShape, talk.AnyShape}},
			}
		case "sqlite":
			perRow := int64(0)
			if raw, present := row["perRow"]; present {
				n, ok := raw.(int64)
				if !ok {
					return nil, &talk.HostError{Code: talk.InvalidValue, Detail: "invalid sqlite perRow"}
				}
				perRow = n
			}
			def, err = core.SqliteCapability(&replaySqlite{replay: out, databases: map[string]*talk.SegmentLifecycle{}}, costs, perRow)
			statement := []talk.Shape{talk.TextShape, talk.AnyShape, talk.Optional(talk.NumberShape)}
			out.declarations[name] = map[string]talk.OperationCheck{
				"query":    {Mode: talk.Immediate, Args: statement},
				"change":   {Mode: talk.Immediate, Args: statement},
				"begin":    {Mode: talk.Immediate},
				"commit":   {Mode: talk.Immediate},
				"rollback": {Mode: talk.Immediate},
			}
		case "locale":
			def, err = core.LocaleCapability(replayLocale{out}, costs)
			collation := talk.Optional(talk.OneOf(talk.MapShape(talk.Field{Key: "sensitivity", Shape: talk.TextShape, Optional: true}, talk.Field{Key: "numeric", Shape: talk.BoolShape, Optional: true}), talk.TextShape))
			names := talk.Optional(talk.OneOf(talk.MapShape(talk.Field{Key: "width", Shape: talk.TextShape, Optional: true}, talk.Field{Key: "form", Shape: talk.TextShape, Optional: true}), talk.TextShape))
			tag := talk.Optional(talk.TextShape)
			out.declarations[name] = map[string]talk.OperationCheck{
				"compare":       {Mode: talk.Immediate, Args: []talk.Shape{talk.TextShape, talk.TextShape, collation, tag}},
				"rank":          {Mode: talk.Immediate, Args: []talk.Shape{talk.ListOf(talk.TextShape), collation, tag}},
				"upper":         {Mode: talk.Immediate, Args: []talk.Shape{talk.TextShape, tag}},
				"lower":         {Mode: talk.Immediate, Args: []talk.Shape{talk.TextShape, tag}},
				"numberSymbols": {Mode: talk.Immediate, Args: []talk.Shape{tag}},
				"monthNames":    {Mode: talk.Immediate, Args: []talk.Shape{names, tag}},
				"dayNames":      {Mode: talk.Immediate, Args: []talk.Shape{names, tag}},
				"tag":           {Mode: talk.Immediate, Args: []talk.Shape{tag}},
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
		var d *talk.CapabilityDef
		var e error
		bound := false
		for _, op := range ops {
			bound = bound || op.SegmentBound
		}
		if bound {
			d, e = core.DefineCoordinatedCapability(name, out.coordinate, ops...)
		} else {
			d, e = core.DefineCapability(name, ops...)
		}
		if e != nil {
			return nil, e
		}
		out.defs[name] = d
	}
	return out, nil
}

// coordinate maps a Grant to its case `coordinator`, or, without one, to a
// coordinator of its own.
func (o *operationReplay) coordinate(any) *talk.SegmentLifecycle {
	if c := o.coordinators[o.coordinator]; c != nil {
		return c
	}
	c := &talk.SegmentLifecycle{Begin: o.effect("begin"), Commit: o.effect("commit"), Rollback: o.effect("rollback")}
	if o.coordinator != "" {
		o.coordinators[o.coordinator] = c
	}
	return c
}

func (o *operationReplay) grants(setup Setup) (map[string]*talk.Grant, error) {
	out := map[string]*talk.Grant{}
	grants, _ := setup["grants"].(Setup)
	for name, raw := range grants {
		row := raw.(Setup)
		o.coordinator, _ = row["coordinator"].(string)
		defName := name
		if n, ok := row["capability"].(string); ok {
			defName = n
		}
		d := o.defs[defName]
		if d == nil {
			return nil, fmt.Errorf("unknown Capability %s", defName)
		}
		binding := row["binding"]
		if d.Name() == "sqlite" {
			binding = sqliteBindingOf(binding)
		}
		if row["ops"] == "all" {
			g := d.GrantAll(binding)
			if g == nil {
				return nil, &talk.HostError{Code: talk.InvalidValue, Detail: "the binding has no Segment Coordinator"}
			}
			out[name] = g
			continue
		}
		var ops []string
		for _, op := range row["ops"].([]any) {
			ops = append(ops, op.(string))
		}
		g, e := d.Grant(ops, binding)
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
	t.replay.values.receive(args)
	_, err := t.replay.invoke("timer.schedule", talk.FireAndForget, c)
	return err
}
func (t replayTimer) Cancel(c *talk.Call, name string) error {
	_, err := t.replay.invoke("timer.cancel", talk.FireAndForget, c)
	return err
}
func (o *operationReplay) invoke(key string, mode talk.Mode, c *talk.Call) (talk.Value, error) {
	if o.crossing != nil {
		o.crossing(string(c.ID()))
	}
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
				x, e := o.values.construct(p.Val)
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
		return o.values.construct(value.Value)
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

type replayConsole struct{ replay *operationReplay }

func (h replayConsole) Write(c *talk.Call, value talk.Value) error {
	h.replay.values.receive(value)
	_, err := h.replay.invoke("console.write", talk.FireAndForget, c)
	return err
}
func (h replayConsole) Read(c *talk.Call) error {
	h.replay.calls[c.ID()] = c
	if len(h.replay.stubs["console.read"]) == 0 {
		return nil
	}
	_, err := h.replay.invoke("console.read", talk.Suspending, c)
	return err
}

type replayCalendar struct{ replay *operationReplay }

func (h replayCalendar) Today(c *talk.Call, zone string) (talk.Value, error) {
	return h.replay.invoke("calendar.today", talk.Immediate, c)
}
func (h replayCalendar) Now(c *talk.Call, zone string) (talk.Value, error) {
	return h.replay.invoke("calendar.now", talk.Immediate, c)
}
func (h replayCalendar) ToCivil(c *talk.Call, instant talk.Value, zone string) (talk.Value, error) {
	return h.replay.invoke("calendar.toCivil", talk.Immediate, c)
}
func (h replayCalendar) ToInstant(c *talk.Call, civil talk.Value, disambiguation, zone string) (talk.Value, error) {
	return h.replay.invoke("calendar.toInstant", talk.Immediate, c)
}
func (h replayCalendar) Offset(c *talk.Call, instant talk.Value, zone string) (talk.Value, error) {
	return h.replay.invoke("calendar.offset", talk.Immediate, c)
}
func (h replayCalendar) Zone(c *talk.Call, zone string) (talk.Value, error) {
	return h.replay.invoke("calendar.zone", talk.Immediate, c)
}

type replayLocale struct{ replay *operationReplay }

func (h replayLocale) Compare(c *talk.Call, a, b, opts talk.Value, tag string) (talk.Value, error) {
	return h.replay.invoke("locale.compare", talk.Immediate, c)
}
func (h replayLocale) Rank(c *talk.Call, texts, opts talk.Value, tag string) (talk.Value, error) {
	return h.replay.invoke("locale.rank", talk.Immediate, c)
}
func (h replayLocale) Upper(c *talk.Call, s talk.Value, tag string) (talk.Value, error) {
	return h.replay.invoke("locale.upper", talk.Immediate, c)
}
func (h replayLocale) Lower(c *talk.Call, s talk.Value, tag string) (talk.Value, error) {
	return h.replay.invoke("locale.lower", talk.Immediate, c)
}
func (h replayLocale) NumberSymbols(c *talk.Call, tag string) (talk.Value, error) {
	return h.replay.invoke("locale.numberSymbols", talk.Immediate, c)
}
func (h replayLocale) MonthNames(c *talk.Call, opts talk.Value, tag string) (talk.Value, error) {
	return h.replay.invoke("locale.monthNames", talk.Immediate, c)
}
func (h replayLocale) DayNames(c *talk.Call, opts talk.Value, tag string) (talk.Value, error) {
	return h.replay.invoke("locale.dayNames", talk.Immediate, c)
}
func (h replayLocale) Tag(c *talk.Call, tag string) (talk.Value, error) {
	return h.replay.invoke("locale.tag", talk.Immediate, c)
}

// effect consumes lifecycle Stubs by Script and Grant, for both custom and
// Standard Segment participants.
func (o *operationReplay) effect(phase string) func(talk.SegmentContext) talk.EffectResult {
	return func(ctx talk.SegmentContext) talk.EffectResult {
		key := ctx.ScriptName + "." + ctx.GrantName + "." + phase
		queue := o.effectStubs[key]
		if len(queue) == 0 {
			if o.strict && o.malformed == nil {
				o.malformed = fmt.Errorf("No lifecycle Stub for %s.%s phase=%s", ctx.ScriptName, ctx.GrantName, phase)
			}
			return talk.EffectResult{Status: talk.EffectUnknown, Detail: "missing lifecycle Stub: " + key}
		}
		o.effectStubs[key] = queue[1:]
		return talk.EffectResult{Status: talk.EffectStatus(queue[0]["status"].Raw)}
	}
}

type replayStore struct{ replay *operationReplay }

func (h replayStore) Begin(c talk.SegmentContext) talk.EffectResult {
	return h.replay.effect("begin")(c)
}
func (h replayStore) Commit(c talk.SegmentContext) talk.EffectResult {
	return h.replay.effect("commit")(c)
}
func (h replayStore) Rollback(c talk.SegmentContext) talk.EffectResult {
	return h.replay.effect("rollback")(c)
}
func (h replayStore) Get(c *talk.Call, key string, fallback talk.Value) (talk.Value, error) {
	h.replay.values.receive(fallback)
	return h.replay.invoke("store.get", talk.Immediate, c)
}
func (h replayStore) Set(c *talk.Call, key string, v talk.Value) error {
	h.replay.values.receive(v)
	_, e := h.replay.invoke("store.set", talk.Immediate, c)
	return e
}
func (h replayStore) Delete(c *talk.Call, key string) error {
	_, e := h.replay.invoke("store.delete", talk.Immediate, c)
	return e
}
func (h replayStore) Keys(c *talk.Call, prefix string) (talk.Value, error) {
	return h.replay.invoke("store.keys", talk.Immediate, c)
}
func (h replayStore) Increment(c *talk.Call, key string, by talk.Value) (talk.Value, error) {
	return h.replay.invoke("store.increment", talk.Immediate, c)
}
func (h replayStore) Swap(c *talk.Call, key string, expected, replacement talk.Value) (bool, error) {
	h.replay.values.receive(expected)
	h.replay.values.receive(replacement)
	v, e := h.replay.invoke("store.swap", talk.Immediate, c)
	if e != nil {
		return false, e
	}
	b, ok := v.AsBool()
	if !ok {
		return false, fmt.Errorf("store.swap Stub is not boolean")
	}
	return b, nil
}
