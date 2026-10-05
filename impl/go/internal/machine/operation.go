package machine

import "github.com/odogono/odgn-talk/impl/go/internal/value"

// OperationFunc belongs to one execution turn. The Host adapter validates
// arguments, pays the declaration through pay and invokes the Host. Immediate
// results convert on that turn; suspending calls register plain wait/member
// state and convert through a new turn callback at resumption. No callback is
// retained in Run state.
type OperationFunc func(grant, operation string, args []value.Value, pay func(int64, int64) bool) (value.Value, *value.Value, bool)

func (r *Run) PayHost(fuel, alloc int64) bool { return r.pay(fuel, alloc) }

// ChargeHost refuses unpaid work without faulting until the Host returns.
func (r *Run) ChargeHost(fuel int64) bool {
	if r.Cancelling && fuel > r.CleanupBudget-r.CleanupFuel || !r.Cancelling && (r.Limits.Fuel > 0 || r.Limits.Bounded) && fuel > r.Limits.Fuel-r.Fuel {
		return false
	}
	return r.pay(fuel, 0)
}
func (r *Run) FaultHostFuel() { r.fault("fuel") }

func ErrorValue(code string, fields ...value.Pair) value.Value { return failure(code, fields...) }
