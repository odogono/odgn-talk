package northtalk

import (
	"reflect"
	"time"
)

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
	if standardImplementationMissing(impl) {
		return nil, &HostError{InvalidValue, "missing timer implementation"}
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

// ConsoleImpl shows written Values and starts reads. Read answers through the
// Call with a line of text without its line break, including an empty line.
type ConsoleImpl interface {
	Write(c *Call, value Value) error
	Read(c *Call) error
}

// ConsoleCapability defines fire-and-forget write and suspending read. Its
// fixed read deadline allows human input independently of the Script's MaxWait.
func (c *Core) ConsoleCapability(impl ConsoleImpl, costs Costs) (*CapabilityDef, error) {
	if standardImplementationMissing(impl) {
		return nil, &HostError{InvalidValue, "missing console implementation"}
	}
	write, err := standardCost(costs, "write")
	if err != nil {
		return nil, err
	}
	read, err := standardCost(costs, "read")
	if err != nil {
		return nil, err
	}
	return c.DefineCapability("console",
		Operation{Name: "write", Mode: FireAndForget, Args: []Shape{ValueShape}, Cost: write, Errors: []ErrorDecl{},
			Fire: func(call *Call, args []Value) error { return impl.Write(call, args[0]) },
		},
		Operation{Name: "read", Mode: Suspending, Result: TextShape, Cost: read, Errors: []ErrorDecl{}, MaxPending: 2147483647 * time.Millisecond,
			Start: func(call *Call, _ []Value) error { return impl.Read(call) },
		},
	)
}

func standardImplementationMissing(impl any) bool {
	if impl == nil {
		return true
	}
	// A typed nil has methods, but supplies no Host implementation.
	v := reflect.ValueOf(impl)
	switch v.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Pointer, reflect.Slice:
		return v.IsNil()
	}
	return false
}
