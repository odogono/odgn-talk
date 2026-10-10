package messagelayer

import (
	"encoding/json"

	talk "github.com/odogono/odgn-talk/impl/go"
)

// Declarations and Shapes use the Host Manifest's data model, which is the
// corpus case.toml's written as JSON (spec/09-embedding.md#the-host-manifest-format).

type operationDecl struct {
	Name         string            `json:"name"`
	Mode         string            `json:"mode"`
	Args         []json.RawMessage `json:"args"`
	Result       json.RawMessage   `json:"result"`
	Cost         costDecl          `json:"cost"`
	Errors       *[]errorDecl      `json:"errors"`
	MaxPending   int64             `json:"maxPending"`
	Scope        *talk.ScopeDecl   `json:"scope"`
	SegmentBound bool              `json:"segmentBound"`
}

type costDecl struct {
	Fuel  int64 `json:"fuel"`
	Alloc int64 `json:"alloc"`
}

type errorDecl struct {
	Code   string      `json:"code"`
	Fields []fieldDecl `json:"fields"`
}

type fieldDecl struct {
	Key      string          `json:"key"`
	Shape    json.RawMessage `json:"shape"`
	Optional bool            `json:"optional"`
}

var modes = map[string]talk.Mode{"immediate": talk.Immediate, "suspending": talk.Suspending, "fire-and-forget": talk.FireAndForget}

var modeNames = map[talk.Mode]string{talk.Immediate: "immediate", talk.Suspending: "suspending", talk.FireAndForget: "fire-and-forget"}

// operation builds an Operation with no callbacks; the caller binds them.
func (d operationDecl) operation() (talk.Operation, error) {
	op := talk.Operation{Name: d.Name, Cost: talk.Cost{Fuel: d.Cost.Fuel, Alloc: d.Cost.Alloc}, Scope: d.Scope, SegmentBound: d.SegmentBound}
	mode, ok := modes[d.Mode]
	if !ok {
		return op, protocolErrorf("Operation %s has invalid mode %q", d.Name, d.Mode)
	}
	op.Mode = mode
	for _, raw := range d.Args {
		s, err := shape(raw)
		if err != nil {
			return op, err
		}
		op.Args = append(op.Args, s)
	}
	if len(d.Result) > 0 {
		s, err := shape(d.Result)
		if err != nil {
			return op, err
		}
		op.Result = s
	}
	if d.Errors != nil {
		op.Errors = []talk.ErrorDecl{}
		for _, e := range *d.Errors {
			fs, err := shapeFields(e.Fields)
			if err != nil {
				return op, err
			}
			op.Errors = append(op.Errors, talk.ErrorDecl{Code: e.Code, Fields: fs})
		}
	}
	op.MaxPending = milliseconds(d.MaxPending)
	return op, nil
}

var namedShapes = map[string]talk.Shape{"any": talk.AnyShape, "value": talk.ValueShape, "nothing": talk.NothingShape, "boolean": talk.BoolShape, "number": talk.NumberShape, "text": talk.TextShape, "bytes": talk.BytesShape, "instant": talk.InstantShape, "range": talk.RangeShape, "civil date": talk.CivilDateShape, "pattern": talk.PatternShape, "function": talk.FunctionShape}

type shapeDecl struct {
	Quantity *string           `json:"quantity"`
	UnitKind *string           `json:"unitKind"`
	Optional json.RawMessage   `json:"optional"`
	List     json.RawMessage   `json:"list"`
	OneOf    []json.RawMessage `json:"oneOf"`
	Map      *[]fieldDecl      `json:"map"`
	OpenMap  *[]fieldDecl      `json:"openMap"`
	Open     bool              `json:"open"`
}

func shape(raw json.RawMessage) (talk.Shape, error) {
	var name string
	if json.Unmarshal(raw, &name) == nil {
		if s, ok := namedShapes[name]; ok {
			return s, nil
		}
		return talk.Shape{}, protocolErrorf("unknown Shape %q", name)
	}
	var d shapeDecl
	if err := json.Unmarshal(raw, &d); err != nil {
		return talk.Shape{}, protocolErrorf("malformed Shape %s", raw)
	}
	switch {
	case d.Quantity != nil:
		return talk.QuantityOf(*d.Quantity), nil
	case d.UnitKind != nil:
		return talk.QuantityKind(*d.UnitKind), nil
	case len(d.Optional) > 0:
		s, err := shape(d.Optional)
		return talk.Optional(s), err
	case len(d.List) > 0:
		s, err := shape(d.List)
		return talk.ListOf(s), err
	case d.OneOf != nil:
		var ss []talk.Shape
		for _, x := range d.OneOf {
			s, err := shape(x)
			if err != nil {
				return s, err
			}
			ss = append(ss, s)
		}
		return talk.OneOf(ss...), nil
	case d.Map != nil:
		fs, err := shapeFields(*d.Map)
		if d.Open {
			return talk.OpenMap(fs...), err
		}
		return talk.MapShape(fs...), err
	case d.OpenMap != nil:
		fs, err := shapeFields(*d.OpenMap)
		return talk.OpenMap(fs...), err
	}
	return talk.Shape{}, protocolErrorf("unsupported Shape %s", raw)
}

func shapeFields(ds []fieldDecl) ([]talk.Field, error) {
	var out []talk.Field
	for _, d := range ds {
		s, err := shape(d.Shape)
		if err != nil {
			return nil, err
		}
		out = append(out, talk.Field{Key: d.Key, Shape: s, Optional: d.Optional})
	}
	return out, nil
}

// limitsDecl is talk.ts's Limits; a field it leaves out keeps its default.
type limitsDecl struct {
	FuelPerRun      *int64 `json:"fuelPerRun"`
	AllocPerRun     *int64 `json:"allocPerRun"`
	PersistentState *int64 `json:"persistentState"`
	CallDepth       *int   `json:"callDepth"`
	PatternSize     *int   `json:"patternSize"`
	MailboxDepth    *int   `json:"mailboxDepth"`
	MaxWaitMs       *int64 `json:"maxWaitMs"`
	MaxJoin         *int   `json:"maxJoin"`
	CleanupBudget   *int64 `json:"cleanupBudget"`
}

func (d limitsDecl) limits() talk.Limits {
	l := talk.DefaultLimits()
	set := func(dst *int64, src *int64) {
		if src != nil {
			*dst = *src
		}
	}
	setInt := func(dst *int, src *int) {
		if src != nil {
			*dst = *src
		}
	}
	set(&l.FuelPerRun, d.FuelPerRun)
	set(&l.AllocPerRun, d.AllocPerRun)
	set(&l.PersistentState, d.PersistentState)
	setInt(&l.CallDepth, d.CallDepth)
	setInt(&l.PatternSize, d.PatternSize)
	setInt(&l.MailboxDepth, d.MailboxDepth)
	if d.MaxWaitMs != nil {
		l.MaxWait = milliseconds(*d.MaxWaitMs)
	}
	setInt(&l.MaxJoin, d.MaxJoin)
	set(&l.CleanupBudget, d.CleanupBudget)
	return l
}

// overrideDecl is talk.ts's LimitOverride, for one Delivery.
type overrideDecl struct {
	FuelPerRun  *int64 `json:"fuelPerRun"`
	AllocPerRun *int64 `json:"allocPerRun"`
	MaxWaitMs   *int64 `json:"maxWaitMs"`
	MaxJoin     *int   `json:"maxJoin"`
}

func (d *overrideDecl) override() *talk.LimitOverride {
	if d == nil {
		return nil
	}
	o := &talk.LimitOverride{}
	if d.FuelPerRun != nil {
		o.Set |= talk.OverrideFuelPerRun
		o.FuelPerRun = *d.FuelPerRun
	}
	if d.AllocPerRun != nil {
		o.Set |= talk.OverrideAllocPerRun
		o.AllocPerRun = *d.AllocPerRun
	}
	if d.MaxWaitMs != nil {
		o.Set |= talk.OverrideMaxWait
		o.MaxWait = milliseconds(*d.MaxWaitMs)
	}
	if d.MaxJoin != nil {
		o.Set |= talk.OverrideMaxJoin
		o.MaxJoin = *d.MaxJoin
	}
	return o
}

// message reads a Message: {name, args (V), limits}.
func (f fields) message(key string, g *group) (talk.Message, error) {
	m, err := f.sub(key)
	if err != nil {
		return talk.Message{}, err
	}
	name, err := m.str("name")
	if err != nil {
		return talk.Message{}, err
	}
	args, err := m.values("args", g)
	if err != nil {
		return talk.Message{}, err
	}
	var limits *overrideDecl
	if m.has("limits") {
		if err := m.decode("limits", &limits); err != nil {
			return talk.Message{}, err
		}
	}
	return talk.Message{Name: name, Args: args, Limits: limits.override()}, nil
}
