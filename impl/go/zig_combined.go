//go:build talk_zig_experimental

package northtalk

import (
	"context"
	"fmt"
	"strconv"
	"sync/atomic"
	"time"
)

// zigTokens are combined exchanges' correlation tokens: positive, and never
// reused in a process, so never in a guest's Session.
var zigTokens atomic.Uint64

// zigCorrelation is a combined input's provisional Pending registration,
// made before its frame is sent. Its final reply retires the token, after
// which a cancellation goes by delivery id. Guarded by frameMu, the receipt
// lock that also serializes admission.
type zigCorrelation struct {
	token    uint64
	delivery DeliveryID
	refused  bool
	// sent is whether the combined frame is ordered ahead of any cancel;
	// early is a cancellation requested before then, sent by delivery id.
	sent, early bool
}

// correlate rewrites a token cancellation as it is transmitted, under the
// receipt lock: one queued before the final reply retired its token cancels
// the delivery id instead, and one for a refused admission has nothing to
// cancel, so it becomes a Trace-silent query.
func (b *zigGroup) correlate(fields map[string]any) {
	c, ok := fields["token"].(*zigCorrelation)
	if !ok {
		return
	}
	delete(fields, "token")
	switch {
	case c.delivery != "":
		fields["m"], fields["delivery"] = "cancel-delivery", string(c.delivery)
	case c.refused:
		fields["m"] = "queued-inputs"
	default:
		fields["token"] = int64(c.token)
	}
}

func (b *zigGroup) cancelCorrelated(c *zigCorrelation) {
	b.frameMu.Lock()
	if !c.sent || c.refused {
		// Nothing the guest could name yet, or nothing to cancel.
		c.early = !c.sent
		b.frameMu.Unlock()
		return
	}
	b.frameMu.Unlock()
	if _, err := b.send("cancel-correlated", map[string]any{"token": c}); err != nil {
		panic(err)
	}
	b.ready()
}

// admitted registers an admitted input's future before the receipt lock is
// released: Trace/OnReady may enqueue or Pump immediately after it.
func (b *zigGroup) admitted(id DeliveryID, how string, ctx context.Context, d *Deciding) *Pending {
	var pending *Pending
	cancel := func() {
		b.cancelDelivery(id)
	}
	if how == "request" {
		pending = &Pending{done: make(chan struct{})}
		b.pendingMu.Lock()
		b.pending[id] = pending
		b.pendingMu.Unlock()
		if ctx != nil {
			pending.stop = context.AfterFunc(ctx, cancel)
		}
	}
	if d != nil {
		b.pendingMu.Lock()
		b.decisions[string(id)] = d
		b.pendingMu.Unlock()
		if ctx != nil {
			d.stop = context.AfterFunc(ctx, func() {
				// A sealed Verdict ignores its deadline.
				if !d.isSealed() {
					cancel()
				}
			})
		}
	}
	return pending
}

// zbAdmission writes a Request's or Function call's input after its ref.
func (b *zigGroup) zbAdmission(w *zbWriter, s *Script, to *Object, fn *Value, m Message) error {
	if fn != nil {
		return b.zbCallee(w, *fn, m)
	}
	return b.zbAddress(w, s, to, m)
}

// queueBinary admits a Request or Function call in a binary frame. Queued
// behind another export, it crosses as the JSON input queue would send.
func (b *zigGroup) queueBinary(s *Script, to *Object, fn *Value, m Message, ctx context.Context, notify bool) (DeliveryID, *Pending, error) {
	tag, method := zbRequest, "request"
	if fn != nil {
		tag, method = zbCall, "call"
	}
	w, split := b.zbInput(tag)
	w.key("group")
	w.ptext(b.groupHandle())
	if err := b.zbAdmission(w, s, to, fn, m); err != nil {
		return "", nil, err
	}
	frame := w.frame(split, false, func() (map[string]any, error) {
		_, fields, _, err := b.queueFields(s, to, fn, m, "request")
		return fields, err
	})
	var id DeliveryID
	var pending *Pending
	packet, err := b.exchangeFrame(method, map[string]any{}, frame, func(p zigPacket) error {
		switch {
		case p.bin != nil && p.bin.ok:
			id = DeliveryID(p.bin.delivery)
		case p.bin == nil && !p.err.present():
			id = DeliveryID(zigText(p.ok.get("delivery")))
		default:
			return nil
		}
		pending = b.admitted(id, "request", ctx, nil)
		return nil
	})
	if err != nil {
		return "", nil, err
	}
	if packet.bin != nil && !packet.bin.ok {
		return "", nil, packet.bin.failure()
	}
	if notify {
		b.ready()
	}
	return id, pending, nil
}

// pumpBinary is pump's exchange in a binary frame.
func (b *zigGroup) pumpBinary(now time.Time, options PumpOptions) (PumpResult, error) {
	w, split := b.zbInput(zbPump)
	w.key("group")
	w.ptext(b.groupHandle())
	zbClock(w, now, options)
	var result PumpResult
	packet, err := b.exchangeFrame("pump", map[string]any{}, w.frame(split, true, nil), func(p zigPacket) error {
		if p.bin == nil || !p.bin.ok {
			return nil
		}
		var err error
		result, err = b.zbPumpResult(p.bin)
		clear(b.restoredCalls)
		return err
	})
	if err == nil && packet.bin != nil && !packet.bin.ok {
		err = packet.bin.failure()
	}
	return result, err
}

func zigPumpFields(now time.Time, options PumpOptions) map[string]any {
	return map[string]any{"now": now.Round(0).UTC().Truncate(time.Microsecond).Format(time.RFC3339Nano), "fuelSlice": options.FuelSlice, "fuelCap": options.FuelCap}
}

// pumpCombined claims the worker as pump does, so a competing worker is
// refused before admission, and admits once; the admission Pumps once.
// Readiness is notified only after the guard is released, and only when the
// Pump is refused with the admitted input still queued.
func (b *zigGroup) pumpCombined(what string, now time.Time, o PumpOptions, admit func(*combinedPump) (DeliveryID, *Pending, error)) (DeliveryID, *Pending, PumpResult, error) {
	if !b.reg.binary {
		return "", nil, PumpResult{}, backendUnsupported(what)
	}
	if err := b.beginWorker("pump", zigPumpFields(now, o)); err != nil {
		return "", nil, PumpResult{}, err
	}
	notify := false
	defer func() {
		if notify {
			b.ready()
		}
	}()
	defer b.group.endWorker()
	if err := b.syncKinds(); err != nil {
		return "", nil, PumpResult{}, err
	}
	c := &combinedPump{now: now, options: o}
	id, pending, err := admit(c)
	if err != nil {
		return "", nil, PumpResult{}, err
	}
	notify = c.err != nil
	return id, pending, c.result, c.err
}

// queueCombined sends the combined input once the ordinary checks pass. A
// refused admission returns its error; a refused Pump leaves c.err, with the
// admitted id and Pending.
func (b *zigGroup) queueCombined(s *Script, to *Object, fn *Value, m Message, ctx context.Context, name string, c *combinedPump) (DeliveryID, *Pending, error) {
	clock := c.now.Round(0).UTC().Truncate(time.Microsecond)
	if clock.Year() < 1 || clock.Year() > 9999 {
		// The guest can't read the Clock. As natively, admit the input and
		// refuse its Pump, which leaves it queued.
		id, pending, err := b.queueBinary(s, to, fn, m, ctx, false)
		if err != nil {
			return "", nil, err
		}
		fields := map[string]string{"clock": clock.Format(time.RFC3339Nano)}
		if c.options.FuelSlice > 0 {
			fields["fuel-slice"] = strconv.FormatInt(c.options.FuelSlice, 10)
		}
		if c.options.FuelCap > 0 {
			fields["fuel-cap"] = strconv.FormatInt(c.options.FuelCap, 10)
		}
		b.group.recordRefusal("pump", nil, fields, InvalidValue)
		c.err = &HostError{InvalidValue, "Clock outside year 1–9999"}
		return id, pending, nil
	}
	token := zigTokens.Add(1)
	if token == 0 || token > 1<<63-1 {
		return "", nil, fmt.Errorf("talk: correlation tokens exhausted")
	}
	tag, method := zbRequestPump, "request-pump"
	if fn != nil {
		tag, method = zbCallPump, "call-pump"
	}
	w, split := b.zbInput(tag)
	w.key("group")
	w.ptext(b.groupHandle())
	w.key("token")
	w.int(int64(token))
	if err := b.zbAdmission(w, s, to, fn, m); err != nil {
		return "", nil, err
	}
	zbClock(w, c.now, c.options)
	// Register before transmission, so cancellation needs no delivery id.
	corr := &zigCorrelation{token: token}
	pending := &Pending{done: make(chan struct{})}
	if ctx != nil {
		pending.stop = context.AfterFunc(ctx, func() { b.cancelCorrelated(corr) })
	}
	var id DeliveryID
	frame := w.frame(split, true, nil)
	frame.sent = func() { corr.sent = true }
	packet, err := b.exchangeFrame(method, map[string]any{}, frame, func(p zigPacket) error {
		if p.bin == nil {
			return nil
		}
		if !p.bin.hasDelivery {
			corr.refused = true
			return nil
		}
		if p.bin.token != token {
			return fmt.Errorf("Zig reply names another token")
		}
		// Install the delivery and retire the token before any observation.
		id = DeliveryID(p.bin.delivery)
		corr.delivery = id
		b.pendingMu.Lock()
		b.pending[id] = pending
		b.pendingMu.Unlock()
		if !p.bin.ok {
			c.err = p.bin.failure()
			return nil
		}
		var err error
		c.result, err = b.zbPumpResult(p.bin)
		clear(b.restoredCalls)
		return err
	})
	refused := err != nil || packet.bin != nil && !packet.bin.hasDelivery
	if refused {
		b.frameMu.Lock()
		if corr.delivery == "" {
			corr.refused = true
		}
		admitted := corr.delivery != ""
		b.frameMu.Unlock()
		if !admitted && pending.stop != nil {
			pending.stop()
		}
	}
	if err != nil {
		return id, nil, err
	}
	if packet.bin != nil && !packet.bin.hasDelivery {
		return "", nil, packet.bin.failure()
	}
	b.frameMu.Lock()
	early := corr.early
	b.frameMu.Unlock()
	if early {
		// Cancelled before the frame was ordered: cancel the admitted input.
		b.cancelDelivery(id)
	}
	return id, pending, nil
}
