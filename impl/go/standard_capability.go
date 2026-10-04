package northtalk

import "reflect"

// Costs supplies the copied, per-Operation costs of a Standard Capability.
type Costs map[string]Cost

// ClockCapability defines clock.now, which reads the current Pump's Clock.
func (c *Core) ClockCapability(costs Costs) (*CapabilityDef, error) {
	cost, err := standardCost(costs, "now")
	if err != nil {
		return nil, err
	}
	return c.DefineCapability("clock", Operation{
		Name: "now", Mode: Immediate, Result: InstantShape, Cost: cost, Errors: []ErrorDecl{},
		Do: func(call *Call, _ []Value) (Value, error) {
			return Instant(call.Now().Unix(), int32(call.Now().Nanosecond()))
		},
	})
}

// TimerImpl stores timers by Script and name. The Host delivers due messages
// with Script.Deliver; the Core does not store or fire durable timers.
type TimerImpl interface {
	Schedule(c *Call, name string, at Value, message string, args Value) error
	Cancel(c *Call, name string) error
}

// TimerCapability defines the fixed fire-and-forget timer Operations.
func (c *Core) TimerCapability(impl TimerImpl, costs Costs) (*CapabilityDef, error) {
	if impl == nil {
		return nil, &HostError{InvalidValue, "missing timer implementation"}
	}
	// An interface holding a nil pointer (or another nilable implementation)
	// has methods in its type, but supplies no Host implementation.
	v := reflect.ValueOf(impl)
	switch v.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Pointer, reflect.Slice:
		if v.IsNil() {
			return nil, &HostError{InvalidValue, "missing timer implementation"}
		}
	}
	schedule, err := standardCost(costs, "schedule")
	if err != nil {
		return nil, err
	}
	cancel, err := standardCost(costs, "cancel")
	if err != nil {
		return nil, err
	}
	return c.DefineCapability("timer",
		Operation{Name: "schedule", Mode: FireAndForget, Args: []Shape{TextShape, InstantShape, TextShape, ListOf(AnyShape)}, Cost: schedule, Errors: []ErrorDecl{},
			Fire: func(call *Call, args []Value) error {
				name, _ := args[0].AsText()
				message, _ := args[2].AsText()
				return impl.Schedule(call, name, args[1], message, args[3])
			},
		},
		Operation{Name: "cancel", Mode: FireAndForget, Args: []Shape{TextShape}, Cost: cancel, Errors: []ErrorDecl{},
			Fire: func(call *Call, args []Value) error { name, _ := args[0].AsText(); return impl.Cancel(call, name) },
		},
	)
}

func standardCost(costs Costs, name string) (Cost, error) {
	cost, ok := costs[name]
	if !ok {
		return Cost{}, &HostError{InvalidValue, "missing Standard Capability cost: " + name}
	}
	// DefineCapability validates both copied components against the safe range.
	return cost, nil
}
