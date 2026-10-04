package northtalk

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestPumpRefusesOutOfRangeClockWithoutConsumingInputs(t *testing.T) {
	for _, now := range []time.Time{
		time.Date(0, 1, 1, 0, 0, 0, 0, time.UTC),
		time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC),
		time.Date(292277024627, 1, 1, 0, 0, 0, 0, time.UTC),
		time.Date(1, 1, 1, 0, 0, 0, 0, time.FixedZone("east", 3600)),
	} {
		t.Run(now.String(), func(t *testing.T) {
			var trace lines
			g := New().NewGroup(GroupOptions{Trace: &trace})
			s, err := g.Load(LoadOptions{Name: "s", Source: "on go\n return 7\nend go\n"})
			if err != nil {
				t.Fatal(err)
			}
			_, p, err := s.Request(context.Background(), Message{Name: "go"})
			if err != nil {
				t.Fatal(err)
			}
			before := len(trace)
			var result PumpResult
			func() {
				defer func() {
					if v := recover(); v != nil {
						t.Errorf("Pump panicked: %v", v)
					}
				}()
				result, err = g.Pump(now, PumpOptions{})
			}()
			var host *HostError
			if !errors.As(err, &host) || host.Code != InvalidValue {
				t.Fatalf("Pump = %+v, %v; want invalid value", result, err)
			}
			if result.FuelUsed != 0 || len(result.Reports) != 0 {
				t.Fatal(result)
			}
			select {
			case <-p.Done():
				t.Fatal("refusal consumed request")
			default:
			}
			if len(trace) != before+2 || !strings.HasPrefix(trace[before], "> pump clock=") || trace[before+1] != `refused code="invalid value"` {
				t.Fatal(trace)
			}
			// The refusal must neither advance the Clock nor take the queued Request.
			result, err = g.Pump(time.Date(2026, 1, 1, 0, 0, 0, 123456789, time.UTC), PumpOptions{})
			if err != nil || len(result.Reports) != 1 {
				t.Fatalf("next Pump = %+v, %v", result, err)
			}
			value, failure := p.Result()
			if failure != nil || !value.Equal(Int(7)) {
				t.Fatalf("request = %v, %v", value, failure)
			}
			if !strings.HasPrefix(trace[before+2], "> request d1") {
				t.Fatal(trace)
			}
		})
	}
}

func TestPumpAcceptsClockBoundariesAndRefusesDecrease(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	for _, now := range []time.Time{
		time.Date(1, 1, 1, 0, 0, 0, 0, time.UTC),
		time.Date(9999, 12, 31, 23, 59, 59, 999999999, time.UTC),
	} {
		if _, err := g.Pump(now, PumpOptions{}); err != nil {
			t.Fatal(err)
		}
		if _, err := g.Pump(now, PumpOptions{}); err != nil {
			t.Fatal(err)
		}
	}
	_, err := g.Pump(time.Date(9999, 12, 31, 23, 59, 59, 999999998, time.UTC), PumpOptions{})
	var host *HostError
	if !errors.As(err, &host) || host.Code != ClockBackwards {
		t.Fatal(err)
	}
}
