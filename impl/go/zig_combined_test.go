package northtalk

import (
	"context"
	"errors"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

type zigTraceLines struct {
	mu    sync.Mutex
	lines []string
}

func (t *zigTraceLines) Record(line string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.lines = append(t.lines, line)
}

func (t *zigTraceLines) take() []string {
	t.mu.Lock()
	defer t.mu.Unlock()
	lines := t.lines
	t.lines = nil
	return lines
}

// setZigRequestPumpLayout selects the layout for new guests until test cleanup.
func setZigRequestPumpLayout(t *testing.T, layout string) {
	t.Helper()
	old := zigRequestPump
	zigRequestPump = layout
	t.Cleanup(func() { zigRequestPump = old })
}

// zigCombinedLayouts runs f on new guests negotiating the fields layout.
func zigCombinedLayouts(t *testing.T, f func(t *testing.T)) {
	for _, layout := range []string{"fields"} {
		t.Run(layout, func(t *testing.T) {
			setZigRequestPumpLayout(t, layout)
			f(t)
		})
	}
}

func TestZigCombinedPublicTargets(t *testing.T) {
	zigCombinedLayouts(t, func(t *testing.T) {
		t.Run("object", testCombinedObjectRequest)
		t.Run("arity", testCombinedCallArityAtExecution)
	})
}

func TestZigCombinedIntegerBoundary(t *testing.T) {
	zigCombinedLayouts(t, func(t *testing.T) {
		g := New().NewGroup(GroupOptions{})
		s, err := g.Load(LoadOptions{Name: "s", Source: "on echo v\n return v\nend echo"})
		if err != nil {
			t.Fatal(err)
		}
		for _, number := range []string{"-18446744073709551615", "-18446744073709551616", "-18446744073709551617"} {
			v, err := DecodeValue([]byte(`{"$dec":"`+number+`"}`), nil)
			if err != nil {
				t.Fatal(err)
			}
			_, pending, _, err := s.RequestPump(nil, Message{Name: "echo", Args: []Value{v}}, time.Unix(1, 0), PumpOptions{})
			if err != nil {
				t.Fatalf("%s: %v", number, err)
			}
			if back, err := pending.Result(); err != nil || !back.Equal(v) {
				t.Fatalf("%s: %v: %v", number, back, err)
			}
		}
	})
}

func TestZigCombinedRequestAdmitsOnceAndPumpsOnce(t *testing.T) {
	zigCombinedLayouts(t, func(t *testing.T) {
		ready := 0
		trace := &zigTraceLines{}
		g := New().NewGroup(GroupOptions{OnReady: func() { ready++ }, Trace: trace})
		s, err := g.Load(LoadOptions{Name: "s", Source: "script variable total = 0\non accumulate n\n put total + n into total\n return total\nend accumulate\n"})
		if err != nil {
			t.Fatal(err)
		}
		_, earlier, err := s.Request(nil, Message{Name: "accumulate", Args: []Value{Int(2)}})
		if err != nil {
			t.Fatal(err)
		}
		ready = 0
		trace.take()
		id, p, result, err := s.RequestPump(nil, Message{Name: "accumulate", Args: []Value{Int(3)}}, time.Unix(1, 0), PumpOptions{})
		if err != nil || id != "d2" || p == nil || len(result.Reports) == 0 {
			t.Fatalf("%s %v %+v %v", id, p, result, err)
		}
		if v, e := earlier.Result(); e != nil || !v.Equal(Int(2)) {
			t.Fatalf("earlier: %v %v", v, e)
		}
		if v, e := p.Result(); e != nil || !v.Equal(Int(5)) {
			t.Fatalf("combined: %v %v", v, e)
		}
		if ready != 0 {
			t.Fatalf("combined initial admission notified %d times", ready)
		}
		// The ordinary Request and Pump records, and no combined record.
		lines := trace.take()
		requested := slices.IndexFunc(lines, func(l string) bool { return strings.HasPrefix(l, "> request d2 ") })
		pumped := slices.IndexFunc(lines, func(l string) bool { return strings.HasPrefix(l, "> pump ") })
		if requested < 0 || pumped < requested || slices.ContainsFunc(lines, func(l string) bool { return strings.Contains(l, "request-pump") }) {
			t.Fatalf("Trace: %q", lines)
		}
		// A Function call through call-pump, then its staleness at the drain.
		g = New().NewGroup(GroupOptions{})
		home, fn := exportFunction(t, g, "on exported\n return given: 5\nend exported", Limits{})
		_, p, _, err = g.CallPump(nil, fn, nil, nil, time.Unix(2, 0), PumpOptions{})
		if err != nil {
			t.Fatal(err)
		}
		if v, e := p.Result(); e != nil || !v.Equal(Int(5)) {
			t.Fatalf("%v %v", v, e)
		}
		if _, err := home.Reload("on other\nend other", ResetVariables); err != nil {
			t.Fatal(err)
		}
		id, p, _, err = g.CallPump(nil, fn, nil, nil, time.Unix(3, 0), PumpOptions{})
		if err != nil || id == "" || p == nil {
			t.Fatalf("staleness rejected during admission: %s %v", id, err)
		}
		if _, e := p.Result(); e == nil {
			t.Fatal("stale Function succeeded")
		}
	})
}

func TestZigCombinedRefusalsBeforeAdmission(t *testing.T) {
	zigCombinedLayouts(t, func(t *testing.T) {
		var g *Group
		var s *Script
		var inner error
		def, err := New().DefineCapability("api", Operation{Name: "read", Mode: Immediate, Result: NumberShape, Do: func(c *Call, args []Value) (Value, error) {
			// A competing worker, combined or not, is refused before admission.
			_, refused, _, err := s.RequestPump(nil, Message{Name: "ping"}, time.Unix(1, 0), PumpOptions{})
			inner = err
			if refused != nil {
				t.Error("refused worker returned a Pending")
			}
			return Int(1), nil
		}})
		if err != nil {
			t.Fatal(err)
		}
		g = New().NewGroup(GroupOptions{})
		s, err = g.Load(LoadOptions{Name: "s", Source: "on go\n ask api to read\n return it\nend go\non ping\nend ping\n", Limits: Limits{MailboxDepth: 1}, Grants: map[string]*Grant{"api": def.GrantAll(nil)}})
		if err != nil {
			t.Fatal(err)
		}
		_, p, _, err := s.RequestPump(nil, Message{Name: "go"}, time.Unix(1, 0), PumpOptions{})
		if err != nil || !isZigReentrant(inner) {
			t.Fatalf("combined %v, competing %v", err, inner)
		}
		if v, e := p.Result(); e != nil || !v.Equal(Int(1)) {
			t.Fatalf("%v %v", v, e)
		}
		// An admission refusal neither Pumps nor consumes an id.
		if _, err := s.Deliver(Message{Name: "ping"}); err != nil {
			t.Fatal(err)
		}
		id, p, _, err := s.RequestPump(nil, Message{Name: "ping"}, time.Unix(2, 0), PumpOptions{})
		if !errors.Is(err, ErrMailboxFull) || id != "" || p != nil {
			t.Fatalf("mailbox refusal: %s %v %v", id, p, err)
		}
		id, p, _, err = g.CallPump(nil, Int(1), nil, nil, time.Unix(2, 0), PumpOptions{})
		if err == nil || id != "" || p != nil {
			t.Fatalf("invalid Function: %s %v %v", id, p, err)
		}
		if result, err := g.Pump(time.Unix(2, 0), PumpOptions{}); err != nil || len(result.Reports) == 0 {
			t.Fatalf("queued Delivery: %+v %v", result, err)
		}
		if id, _, err := s.Request(nil, Message{Name: "ping"}); err != nil || id != "d3" {
			t.Fatalf("refusals consumed delivery ids: %s %v", id, err)
		}
	})
}

func isZigReentrant(err error) bool {
	var h *HostError
	return errors.As(err, &h) && h.Code == ReentrantCall
}

func TestZigCombinedPumpRefusalRetainsAdmission(t *testing.T) {
	zigCombinedLayouts(t, func(t *testing.T) {
		ready := 0
		var g *Group
		g = New().NewGroup(GroupOptions{OnReady: func() {
			ready++
			// Readiness is published after the worker guard is released.
			if err := g.beginWorker(); err != nil {
				t.Error("readiness published before worker guard release")
			} else {
				g.endWorker()
			}
		}})
		s, err := g.Load(LoadOptions{Name: "s", Source: "on ping\n return 42\nend ping\n"})
		if err != nil {
			t.Fatal(err)
		}
		now := time.Unix(10, 0)
		if _, err := g.Pump(now, PumpOptions{}); err != nil {
			t.Fatal(err)
		}
		ready = 0
		for _, refused := range []struct {
			now time.Time
			o   PumpOptions
		}{{now.Add(-time.Second), PumpOptions{}}, {now, PumpOptions{FuelSlice: -1}}, {time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC), PumpOptions{}}} {
			id, p, _, err := s.RequestPump(nil, Message{Name: "ping"}, refused.now, refused.o)
			if err == nil || id == "" || p == nil {
				t.Fatalf("lost admission: %s %v %v", id, p, err)
			}
			select {
			case <-p.Done():
				t.Fatal("refused Pump executed request")
			default:
			}
			if _, err := g.Pump(now, PumpOptions{}); err != nil {
				t.Fatal(err)
			}
			if v, e := p.Result(); e != nil || !v.Equal(Int(42)) {
				t.Fatalf("%v %v", v, e)
			}
		}
		if ready != 3 {
			t.Fatalf("readiness: %d", ready)
		}
	})
}

func TestZigCombinedOnePumpCanLeavePending(t *testing.T) {
	zigCombinedLayouts(t, func(t *testing.T) {
		g := New().NewGroup(GroupOptions{})
		s, err := g.Load(LoadOptions{Name: "s", Source: "on ping\n repeat 100 times\n end repeat\n return 42\nend ping\n"})
		if err != nil {
			t.Fatal(err)
		}
		_, p, r, err := s.RequestPump(nil, Message{Name: "ping"}, time.Unix(1, 0), PumpOptions{FuelSlice: 1})
		if err != nil || p == nil || r.State != Sliced {
			t.Fatal(r, err)
		}
		select {
		case <-p.Done():
			t.Fatalf("unexpected completion after one slice: %+v", r)
		default:
		}
		if _, err := g.Pump(time.Unix(1, 0), PumpOptions{}); err != nil {
			t.Fatal(err)
		}
		if v, e := p.Result(); e != nil || !v.Equal(Int(42)) {
			t.Fatalf("%v %v", v, e)
		}
	})
}

// A JSON need interrupts the combined exchange; its final reply is still
// binary. A token cancellation sent from the callback is cancel-delivery's.
func TestZigCombinedNeedsAndTokenCancellation(t *testing.T) {
	zigCombinedLayouts(t, func(t *testing.T) {
		trace := &zigTraceLines{}
		ctx, cancel := context.WithCancel(context.Background())
		cancelled := make(chan struct{})
		def, err := New().DefineCapability("api", Operation{Name: "read", Mode: Immediate, Result: NumberShape, Do: func(c *Call, args []Value) (Value, error) {
			cancel()
			// The cancellation must not wait for the paused exchange.
			select {
			case <-cancelled:
			case <-time.After(5 * time.Second):
				t.Error("token cancellation blocked behind the paused exchange")
			}
			return Int(7), nil
		}})
		if err != nil {
			t.Fatal(err)
		}
		g := New().NewGroup(GroupOptions{Trace: trace, OnReady: func() {
			select {
			case <-cancelled:
			default:
				if ctx.Err() != nil {
					close(cancelled)
				}
			}
		}})
		s, err := g.Load(LoadOptions{Name: "s", Source: "on go\n ask api to read\n return it\nend go\non inc n\n return n + 1\nend inc\n", Grants: map[string]*Grant{"api": def.GrantAll(nil)}})
		if err != nil {
			t.Fatal(err)
		}
		_, first, err := s.Request(nil, Message{Name: "go"})
		if err != nil {
			t.Fatal(err)
		}
		id, p, _, err := s.RequestPump(ctx, Message{Name: "inc", Args: []Value{Int(1)}}, time.Unix(1, 0), PumpOptions{})
		if err != nil || id != "d2" {
			t.Fatal(id, err)
		}
		if v, e := first.Result(); e != nil || !v.Equal(Int(7)) {
			t.Fatalf("%v %v", v, e)
		}
		// The queued cancellation lands at the next drain, as cancel-delivery.
		if _, err := g.Pump(time.Unix(2, 0), PumpOptions{}); err != nil {
			t.Fatal(err)
		}
		if !slices.Contains(trace.take(), "> cancel-delivery d2") {
			t.Fatal("token cancellation lacks cancel-delivery's record")
		}
		<-p.Done()
	})
}

// After the final reply retires the token, cancellation goes by delivery id.
func TestZigCombinedLateCancellationUsesDeliveryID(t *testing.T) {
	zigCombinedLayouts(t, func(t *testing.T) {
		trace := &zigTraceLines{}
		ready := make(chan struct{}, 4)
		g := New().NewGroup(GroupOptions{Trace: trace, OnReady: func() { ready <- struct{}{} }})
		s, err := g.Load(LoadOptions{Name: "s", Source: "on go\n return 1\nend go\n"})
		if err != nil {
			t.Fatal(err)
		}
		await := func() {
			t.Helper()
			select {
			case <-ready:
			case <-time.After(5 * time.Second):
				t.Fatal("missing OnReady")
			}
		}
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		// A refused Pump leaves the admitted input queued and retires the token.
		id, p, _, err := s.RequestPump(ctx, Message{Name: "go"}, time.Unix(1, 0), PumpOptions{FuelSlice: -1})
		if err == nil || id != "d1" || p == nil {
			t.Fatal(id, p, err)
		}
		await()
		cancel()
		await()
		if _, err := g.Pump(time.Unix(2, 0), PumpOptions{}); err != nil {
			t.Fatal(err)
		}
		select {
		case <-p.Done():
		default:
			t.Fatal("cancelled Request did not settle")
		}
		if _, failure := p.Result(); failure == nil || failure.Data.Get("reason").String() != `"cancelled"` {
			t.Fatal(failure)
		}
		if !slices.Contains(trace.take(), "> cancel-delivery d1") {
			t.Fatal("late cancellation was not by delivery id")
		}
	})
}

func TestZigCombinedTokenRewrite(t *testing.T) {
	b := &zigGroup{}
	for _, c := range []struct {
		corr   zigCorrelation
		m, key string
		want   any
	}{
		{zigCorrelation{token: 4}, "cancel-correlated", "token", int64(4)},
		{zigCorrelation{token: 4, delivery: "d9"}, "cancel-delivery", "delivery", "d9"},
		{zigCorrelation{token: 4, refused: true}, "queued-inputs", "token", nil},
	} {
		fields := map[string]any{"m": "cancel-correlated", "token": &c.corr}
		b.correlate(fields)
		if fields["m"] != c.m || fields[c.key] != c.want {
			t.Fatalf("%+v rewrote to %v", c.corr, fields)
		}
	}
}

func TestCombinedUnsupportedBackendDoesNotAdmit(t *testing.T) {
	setZigRequestPumpLayout(t, "")
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: "on ping\n return 42\nend ping\n"})
	if err != nil {
		t.Fatal(err)
	}
	for _, call := range []func() (DeliveryID, *Pending, PumpResult, error){
		func() (DeliveryID, *Pending, PumpResult, error) {
			return s.RequestPump(nil, Message{Name: "ping"}, time.Now(), PumpOptions{})
		},
		func() (DeliveryID, *Pending, PumpResult, error) {
			return g.RequestPump(nil, nil, Message{Name: "ping"}, time.Now(), PumpOptions{})
		},
		func() (DeliveryID, *Pending, PumpResult, error) {
			return g.CallPump(nil, Int(1), nil, nil, time.Now(), PumpOptions{})
		},
	} {
		id, p, _, err := call()
		if err == nil || id != "" || p != nil {
			t.Fatalf("unsupported call admitted: %s %v %v", id, p, err)
		}
	}
	id, _, err := s.Request(nil, Message{Name: "ping"})
	if err != nil || id != "d1" {
		t.Fatalf("unsupported call consumed delivery: %s %v", id, err)
	}
}
