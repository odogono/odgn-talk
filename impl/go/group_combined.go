// Private experiment helpers for #1245. Publish the proposed Host APIs only
// after the Go/Zig performance gates pass and the other declarations can land.
package northtalk

import (
	"context"
	"strconv"
	"time"
)

// requestPump admits a Request and performs one Pump while holding the Group's
// worker guard. The Pending may remain unsettled. If Pump refuses after
// admission, the nonempty id and Pending are returned alongside its error.
func (s *Script) requestPump(ctx context.Context, m Message, now time.Time, o PumpOptions) (DeliveryID, *Pending, PumpResult, error) {
	return s.group.requestPump(ctx, s, nil, m, now, o)
}

// requestPump is Request followed by one Pump under a single worker guard.
// Other queued work keeps its ordering; this does not wait for the result.
func (g *Group) requestObjectPump(ctx context.Context, to *Object, m Message, now time.Time, o PumpOptions) (DeliveryID, *Pending, PumpResult, error) {
	return g.requestPump(ctx, nil, to, m, now, o)
}

// combinedBackend is optional: old guests must refuse before admission rather
// than emulate the combined operation with two independent exchanges.
type combinedBackend interface {
	requestPump(context.Context, *Script, *Object, Message, time.Time, PumpOptions) (DeliveryID, *Pending, PumpResult, error)
	callPump(context.Context, Value, []Value, *LimitOverride, time.Time, PumpOptions) (DeliveryID, *Pending, PumpResult, error)
}

func (g *Group) requestPump(ctx context.Context, s *Script, to *Object, m Message, now time.Time, o PumpOptions) (DeliveryID, *Pending, PumpResult, error) {
	if g.backend != nil {
		if b, ok := g.backend.(combinedBackend); ok {
			return b.requestPump(ctx, s, to, m, now, o)
		}
		return "", nil, PumpResult{}, backendUnsupported("combined Request and Pump")
	}
	return g.admitPump(now, o, func() (DeliveryID, *Pending, error) {
		return g.admitWithReady(s, m, ctx, true, nil, delivery{target: to, path: s == nil}, false)
	})
}

// callPump admits a Function call and performs one ordinary Pump. Staleness
// and arity retain Call's drain-time and execution-time behavior.
func (g *Group) callPump(ctx context.Context, fn Value, args []Value, limits *LimitOverride, now time.Time, o PumpOptions) (DeliveryID, *Pending, PumpResult, error) {
	if g.backend != nil {
		if b, ok := g.backend.(combinedBackend); ok {
			return b.callPump(ctx, fn, args, limits, now, o)
		}
		return "", nil, PumpResult{}, backendUnsupported("combined Function call and Pump")
	}
	return g.admitPump(now, o, func() (DeliveryID, *Pending, error) {
		return g.callWithReady(ctx, fn, args, limits, false)
	})
}

func (g *Group) admitPump(now time.Time, o PumpOptions, admit func() (DeliveryID, *Pending, error)) (DeliveryID, *Pending, PumpResult, error) {
	if err := g.beginWorker(); err != nil {
		fields := map[string]string{"clock": now.Round(0).UTC().Truncate(time.Microsecond).Format(time.RFC3339Nano)}
		if o.FuelSlice > 0 {
			fields["fuel-slice"] = strconv.FormatInt(o.FuelSlice, 10)
		}
		if o.FuelCap > 0 {
			fields["fuel-cap"] = strconv.FormatInt(o.FuelCap, 10)
		}
		g.recordRefusal("pump", nil, fields, ReentrantCall)
		return "", nil, PumpResult{}, err
	}
	notify := false
	// Notify only after releasing the guard: a scheduled worker may run as
	// soon as OnReady returns, even before this caller receives its result.
	defer func() {
		if notify && g.options.OnReady != nil {
			g.options.OnReady()
		}
	}()
	// Release even if a Host observation panics, as ordinary Pump does.
	defer g.endWorker()
	id, pending, err := admit()
	if err != nil {
		return "", nil, PumpResult{}, err
	}
	result, err := g.pumpOwned(now, o, true)
	notify = err != nil
	return id, pending, result, err
}
