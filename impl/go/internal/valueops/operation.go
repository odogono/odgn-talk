package valueops

import "northtalk.org/go/internal/value"

// OperationFunc belongs to one execution turn. The Host adapter validates
// arguments, pays the declaration through pay and invokes the Host. Immediate
// results convert on that turn; suspending calls register plain wait/member
// state and convert through a new turn callback at resumption. No callback is
// retained in Run state.
type OperationFunc func(grant, operation string, args []value.Value, pay func(int64, int64) bool) (value.Value, *value.Value, bool)

func ErrorValue(code string, fields ...value.Pair) value.Value { return failure(code, fields...) }
