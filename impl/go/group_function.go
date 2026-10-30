package northtalk

import (
	"context"

	corevalue "northtalk.org/go/internal/value"
)

// Call admits a Function Value into its Home Script's mailbox. Staleness is
// checked at drain, after earlier Host Inputs; arity belongs to the new Run.
func (g *Group) Call(ctx context.Context, fn Value, args []Value, limits *LimitOverride) (DeliveryID, *Pending, error) {
	return g.callWithReady(ctx, fn, args, limits, true, nil)
}

func (g *Group) callWithReady(ctx context.Context, fn Value, args []Value, limits *LimitOverride, notify bool, combined *combinedPump) (DeliveryID, *Pending, error) {
	fields := map[string]string{"fn": fn.String()}
	if len(args) > 0 {
		fields["args"] = argsDisplay(args)
	}
	if limits != nil {
		fields["limits"] = overrideDisplay(*limits)
	}
	code := HostErrorCode("")
	if fn.inner.Kind != corevalue.Function || fn.inner.Function() == nil {
		code = InvalidValue
	} else if !validGroup(fn.inner, g) {
		code = WrongGroup
	}
	if code != "" {
		g.recordRefusal("call-value", nil, fields, code)
		return "", nil, &HostError{code, "invalid Function Value"}
	}
	return g.admitWithReady(nil, Message{Name: fn.String(), Args: args, Limits: limits}, ctx, true, nil, delivery{function: &fn.inner, combined: combined}, notify)
}
