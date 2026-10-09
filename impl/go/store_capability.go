package northtalk

import (
	"reflect"
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
// Shapes, empty keys, result kinds and declared catalogue failure fields. It
// maps every binding to impl as one Segment Coordinator, the same for every
// StoreCapability over impl, so writes to several Stores, or one Store
// through several Grants, in one Segment share its participant (ADR 0069).
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
	coordinator := c.storeCoordinator(impl)
	def, err := c.DefineCoordinatedCapability("store", func(any) *SegmentLifecycle { return coordinator }, ops...)
	if err != nil {
		return nil, err
	}
	def.checks = map[string]operationChecks{}
	for _, op := range ops {
		checks := operationChecks{failure: func(code string, data corevalue.Value) bool {
			return slices.ContainsFunc(op.Errors, func(e ErrorDecl) bool { return e.Code == code }) && storeFailure(code, data)
		}}
		if op.Name != "keys" {
			checks.arguments = func(a []corevalue.Value, _ any, _ []corevalue.Pair) *corevalue.Value {
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

// storeCoordinator gives impl's Segment Coordinator, compared by pointer. An
// impl that can't be compared, such as a struct holding a map, gets a new one.
func (c *Core) storeCoordinator(impl StoreImpl) *SegmentLifecycle {
	coordinator := &SegmentLifecycle{Begin: impl.Begin, Commit: impl.Commit, Rollback: impl.Rollback}
	if !reflect.ValueOf(impl).Comparable() {
		return coordinator
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if known := c.storeCoordinators[impl]; known != nil {
		return known
	}
	if c.storeCoordinators == nil {
		c.storeCoordinators = map[StoreImpl]*SegmentLifecycle{}
	}
	c.storeCoordinators[impl] = coordinator
	return coordinator
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
