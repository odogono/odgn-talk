package northtalk

import (
	"slices"

	"github.com/odogono/odgn-talk/impl/go/internal/machine"
	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
)

// Add applies the Script + rules outside a Run, without charging Fuel or Alloc.
func Add(a, b Value) (Value, error) {
	v, failure := machine.Add(a.inner, b.inner)
	if failure != nil {
		return Nothing, scriptError(*failure)
	}
	return Value{v}, nil
}

// StoreImpl keeps Stores named by the Grant binding. Writes belong to the
// calling Segment; Commit applies them together, and Rollback discards them.
// Omitted fallback and by arguments reach the Host as Nothing.
type StoreImpl interface {
	Begin(ctx SegmentContext) EffectResult
	Commit(ctx SegmentContext) EffectResult
	Rollback(ctx SegmentContext) EffectResult
	Get(c *Call, key string, fallback Value) (Value, error)
	Set(c *Call, key string, value Value) error
	Delete(c *Call, key string) error
	Keys(c *Call, prefix string) (Value, error)
	Increment(c *Call, key string, by Value) (Value, error)
	Swap(c *Call, key string, expected, replacement Value) (bool, error)
}

// StoreCapability defines the six immediate store Operations. The Core checks
// Shapes, empty keys, result kinds and declared catalogue failure fields.
func (c *Core) StoreCapability(impl StoreImpl, costs Costs) (*CapabilityDef, error) {
	if standardImplementationMissing(impl) {
		return nil, &HostError{InvalidValue, "missing store implementation"}
	}
	amount := OneOf(NumberShape, kindShape("quantity"))
	errors := func(codes ...string) []ErrorDecl {
		out := []ErrorDecl{}
		for _, code := range codes {
			out = append(out, ErrorDecl{Code: code})
		}
		return out
	}
	optional := func(args []Value, i int) Value {
		if i < len(args) {
			return args[i]
		}
		return Nothing
	}
	key := func(args []Value) string { s, _ := args[0].AsText(); return s }
	ops := []Operation{
		{Name: "get", Args: []Shape{TextShape, Optional(AnyShape)}, Result: AnyShape, Errors: errors(), Do: func(c *Call, a []Value) (Value, error) { return impl.Get(c, key(a), optional(a, 1)) }},
		{Name: "set", Args: []Shape{TextShape, AnyShape}, Result: NothingShape, SegmentBound: true, Errors: errors("can't store", "store full", "store busy"), Do: func(c *Call, a []Value) (Value, error) { return Nothing, impl.Set(c, key(a), a[1]) }},
		{Name: "delete", Args: []Shape{TextShape}, Result: NothingShape, SegmentBound: true, Errors: errors("store busy"), Do: func(c *Call, a []Value) (Value, error) { return Nothing, impl.Delete(c, key(a)) }},
		{Name: "keys", Args: []Shape{Optional(TextShape)}, Result: ListOf(TextShape), Errors: errors(), Do: func(c *Call, a []Value) (Value, error) {
			prefix, _ := optional(a, 0).AsText()
			return impl.Keys(c, prefix)
		}},
		{Name: "increment", Args: []Shape{TextShape, Optional(amount)}, Result: amount, SegmentBound: true, Errors: errors("wrong kind", "incompatible units", "overflow", "store full", "store busy"), Do: func(c *Call, a []Value) (Value, error) { return impl.Increment(c, key(a), optional(a, 1)) }},
		{Name: "swap", Args: []Shape{TextShape, AnyShape, AnyShape}, Result: BoolShape, SegmentBound: true, Errors: errors("can't store", "store full", "store busy"), Do: func(c *Call, a []Value) (Value, error) { b, e := impl.Swap(c, key(a), a[1], a[2]); return Bool(b), e }},
	}
	for i := range ops {
		cost, err := standardCost(costs, ops[i].Name)
		if err != nil {
			return nil, err
		}
		ops[i].Cost = cost
		ops[i].Mode = Immediate
	}
	def, err := c.DefineSegmentCapability("store", SegmentLifecycle{Begin: impl.Begin, Commit: impl.Commit, Rollback: impl.Rollback}, ops...)
	if err != nil {
		return nil, err
	}
	def.checks = map[string]operationChecks{}
	for _, op := range ops {
		checks := operationChecks{failure: func(code string, data corevalue.Value) bool {
			return slices.ContainsFunc(op.Errors, func(e ErrorDecl) bool { return e.Code == code }) && storeFailure(code, data)
		}}
		if op.Name != "keys" {
			checks.arguments = func(a []corevalue.Value, _ any) *corevalue.Value {
				if a[0].Text == "" {
					e := machine.ErrorValue("invalid key")
					return &e
				}
				return nil
			}
		}
		def.checks[op.Name] = checks
	}
	return def, nil
}

func storeFailure(code string, data corevalue.Value) bool {
	text := func(key string) bool { return data.Get(key).Kind == corevalue.Text }
	switch code {
	case "can't store":
		return text("kind")
	case "store full":
		return text("limit") && slices.Contains([]string{"size", "keys", "value"}, data.Get("limit").Text)
	case "store busy":
		return text("key")
	case "wrong kind":
		return text("expected") && text("got") && slices.ContainsFunc(data.Entries, func(p corevalue.Pair) bool { return p.Key == "value" })
	case "incompatible units":
		return text("left") && text("right")
	case "overflow":
		return text("operator")
	}
	return false
}
