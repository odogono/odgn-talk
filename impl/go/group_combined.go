package northtalk

import (
	"context"
	"time"
)

// RequestPump admits a Request and performs one Pump while holding the Group's
// worker guard. The Pending may remain unsettled. If Pump refuses after
// admission, the nonempty id and Pending are returned alongside its error.
// Like Group.RequestPump, this is a worker call; admission refusal returns no
// id or Pending and does not Pump.
func (s *Script) RequestPump(ctx context.Context, m Message, now time.Time, o PumpOptions) (DeliveryID, *Pending, PumpResult, error) {
	return s.group.requestPump(ctx, s, nil, m, now, o)
}

// RequestPump is Request followed by one Pump under a single worker guard.
// Other queued work keeps its ordering; this does not wait for the result.
// On admission refusal the id and Pending are empty and no Pump runs. A Pump
// refusal retains the admitted id and Pending alongside the error. Like Pump,
// this is a worker call. Unsupported backends refuse before admission.
func (g *Group) RequestPump(ctx context.Context, to *Object, m Message, now time.Time, o PumpOptions) (DeliveryID, *Pending, PumpResult, error) {
	return g.requestPump(ctx, nil, to, m, now, o)
}

// combinedBackend is optional: old guests must refuse before admission rather
// than emulate the combined operation with two independent exchanges.
type combinedBackend interface {
	// pumpCombined claims the worker as Pump does, then admits through the
	// ordinary checks; the backend's admission also performs the one Pump.
	pumpCombined(what string, now time.Time, o PumpOptions, admit func(*combinedPump) (DeliveryID, *Pending, error)) (DeliveryID, *Pending, PumpResult, error)
	queueCombined(s *Script, to *Object, fn *Value, m Message, ctx context.Context, name string, c *combinedPump) (DeliveryID, *Pending, error)
}

// combinedPump carries a combined call's Pump inputs through ordinary
// admission, and its outcome back: a refusal after admission is err.
type combinedPump struct {
	now     time.Time
	options PumpOptions
	result  PumpResult
	err     error
}

func (g *Group) requestPump(ctx context.Context, s *Script, to *Object, m Message, now time.Time, o PumpOptions) (DeliveryID, *Pending, PumpResult, error) {
	if b, ok := g.backend.(combinedBackend); ok {
		return b.pumpCombined("combined Request and Pump", now, o, func(c *combinedPump) (DeliveryID, *Pending, error) {
			return g.admitWithReady(s, m, ctx, true, nil, delivery{target: to, path: s == nil, combined: c}, false)
		})
	}
	return "", nil, PumpResult{}, backendUnsupported("combined Request and Pump")
}

// CallPump admits a Function call and performs one ordinary Pump. Staleness
// and arity retain Call's drain-time and execution-time behavior. This is a
// worker call; admission and Pump refusals have RequestPump's partial-success
// contract, and the Pending can remain unsettled after the single Pump.
func (g *Group) CallPump(ctx context.Context, fn Value, args []Value, limits *LimitOverride, now time.Time, o PumpOptions) (DeliveryID, *Pending, PumpResult, error) {
	if b, ok := g.backend.(combinedBackend); ok {
		return b.pumpCombined("combined Function call and Pump", now, o, func(c *combinedPump) (DeliveryID, *Pending, error) {
			return g.callWithReady(ctx, fn, args, limits, false, c)
		})
	}
	return "", nil, PumpResult{}, backendUnsupported("combined Function call and Pump")
}
