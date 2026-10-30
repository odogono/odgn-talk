package northtalk_test

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
	"time"

	talk "northtalk.org/go"
)

// Compare queued cancellation through both public controls, including cleanup
// preemption, to a separately compiled native Go Host (#1063).
func runQueuedCancellationBridgeCases(t *testing.T) []bridgeObservation {
	t.Helper()
	var out []bridgeObservation
	for _, control := range []string{"run", "request", "owner and parked"} {
		for _, sliced := range []bool{false, true} {
			name := "parked cancellation " + control
			if sliced {
				name += " sliced"
			}
			t.Run(name, func(t *testing.T) {
				o := bridgeObservation{Name: name}
				var trace bridgeTrace
				ready := make(chan struct{}, 16)
				g := talk.New().NewGroup(talk.GroupOptions{Name: "g", Trace: &trace, OnReady: func() { ready <- struct{}{} }})
				s, err := g.Load(talk.LoadOptions{Name: "s", Source: `script variable seen = []
on work n, queued
 try
  put n after seen
  wait 1 s
 finally
  put n * 10 after seen
 end try
end work`})
				if err != nil {
					t.Fatal(err)
				}
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				var pending []*talk.Pending
				for n := int64(1); n <= 3; n++ {
					requestContext := context.Background()
					if n == 2 {
						requestContext = ctx
					}
					_, p, err := s.Request(requestContext, talk.Message{Name: "work", Args: []talk.Value{talk.Int(n)}})
					if err != nil {
						t.Fatal(err)
					}
					pending = append(pending, p)
				}
				capture := func() {
					values := []any{g.Inspect(), s.Counters()}
					for _, p := range pending {
						select {
						case <-p.Done():
							v, e := p.Result()
							values = append(values, []any{v, e})
						default:
							values = append(values, "open")
						}
					}
					data, err := json.Marshal(bridgeCanonical(reflect.ValueOf(values)))
					if err != nil {
						t.Fatal(err)
					}
					o.Values = append(o.Values, string(data))
				}
				pump := func(at time.Time, options talk.PumpOptions) talk.PumpResult {
					r, err := g.Pump(at, options)
					if err != nil {
						t.Fatal(err)
					}
					o.Pumps = append(o.Pumps, bridgeCanonical(reflect.ValueOf(r)))
					capture()
					return r
				}
				pump(bridgeNow, talk.PumpOptions{})
				if control == "owner and parked" {
					s.CancelRun(g.Inspect().Scripts[0].Runs[0].ID)
				}
				if control != "request" {
					s.CancelRun(g.Inspect().Scripts[0].Runs[1].ID)
				} else {
					for len(ready) > 0 {
						<-ready
					}
					cancel()
					select {
					case <-ready:
					case <-time.After(5 * time.Second):
						t.Fatal("cancellation did not notify OnReady")
					}
				}
				options := talk.PumpOptions{}
				if sliced {
					options.FuelCap = 1
				}
				r := pump(bridgeNow, options)
				for i := 0; r.State == talk.Sliced && i < 100; i++ {
					r = pump(bridgeNow, options)
				}
				view := g.Inspect().Scripts[0]
				if control == "owner and parked" {
					if view.Vars[0].Val.String() != "[1, 10, 20, 3]" || len(view.Runs) != 1 || view.Runs[0].Status != talk.Suspended {
						t.Fatal(view)
					}
				} else {
					if view.Vars[0].Val.String() != "[1, 20]" || len(view.Runs) != 2 || view.Runs[1].Status != talk.Parked {
						t.Fatal(view)
					}
				}
				pump(bridgeNow.Add(time.Second), talk.PumpOptions{})
				pump(bridgeNow.Add(2*time.Second), talk.PumpOptions{})
				view = g.Inspect().Scripts[0]
				want := "[1, 20, 10, 3, 30]"
				if control == "owner and parked" {
					want = "[1, 10, 20, 3, 30]"
				}
				if view.Vars[0].Val.String() != want || len(view.Runs) != 0 {
					t.Fatal(view)
				}
				o.Trace = trace.lines
				out = append(out, o)
			})
		}
	}
	return out
}
