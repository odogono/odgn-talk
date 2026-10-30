package northtalk_test

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	talk "northtalk.org/go"
)

// Chapter 8 charges the entire Send before its delivery or reply wait (#1062).
// The shared matrix compares these public observations to a native Go binary.
func runSendBudgetBridgeCases(t *testing.T) []bridgeObservation {
	t.Helper()
	var observations []bridgeObservation
	for _, suffix := range []string{"", " and wait"} {
		for _, tc := range []struct {
			name   string
			limits talk.Limits
			limit  string
		}{
			{"fuel", talk.Limits{FuelPerRun: 6}, "fuel"},
			{"fuel one short", talk.Limits{FuelPerRun: 27}, "fuel"},
			{"allocation", talk.Limits{AllocPerRun: 1}, "alloc"},
			{"allocation one short", talk.Limits{AllocPerRun: 47}, "alloc"},
			{"both", talk.Limits{FuelPerRun: 6, AllocPerRun: 1}, "fuel"},
			{"paid", talk.Limits{FuelPerRun: 100, AllocPerRun: 48}, ""},
		} {
			name := "send" + suffix + " budget " + tc.name
			t.Run(name, func(t *testing.T) {
				o := bridgeObservation{Name: name}
				var trace bridgeTrace
				g := talk.New().NewGroup(talk.GroupOptions{Name: "g", Trace: &trace})
				a, err := g.Load(talk.LoadOptions{Name: "a", Limits: tc.limits, Source: "on go\n send ping with 7 to b" + suffix + "\nend go"})
				if err != nil {
					t.Fatal(err)
				}
				b, err := g.Load(talk.LoadOptions{Name: "b", Source: "on ping n\n return n\nend ping"})
				if err != nil {
					t.Fatal(err)
				}
				_, pending, err := a.Request(nil, talk.Message{Name: "go"})
				if err != nil {
					t.Fatal(err)
				}
				for i := range 2 {
					r, err := g.Pump(bridgeNow, talk.PumpOptions{})
					if err != nil || r.State != talk.Idle || !r.NextDeadline.IsZero() {
						t.Fatal(r, err)
					}
					if i == 0 && tc.limit != "" {
						if r.FuelUsed != 6 || b.Counters().Runs != 0 {
							t.Fatalf("failed Send performed work: Fuel=%d receiver=%+v", r.FuelUsed, b.Counters())
						}
						ends := 0
						for _, report := range r.Reports {
							if end, ok := report.(*talk.RunEnd); ok {
								ends++
								if end.Script != "a" || end.Outcome != talk.LimitFault || end.Limit != tc.limit || end.Fuel != 6 || end.Alloc != 0 || end.At.Unit != "a" || end.At.PC != 4 {
									t.Fatalf("wrong Send fault: %+v", end)
								}
							}
						}
						if ends != 1 {
							t.Fatalf("Send fault produced %d RunEnd reports", ends)
						}
						for _, line := range trace.lines {
							if strings.HasPrefix(line, "send a/r1") || strings.HasPrefix(line, "abandon a/r1") {
								t.Fatal("failed Send created an effect", line)
							}
						}
					}
					if i == 1 && r.FuelUsed != 0 {
						t.Fatal("Send left work for the next Pump", r)
					}
					o.Pumps = append(o.Pumps, bridgeCanonical(reflect.ValueOf(r)))
					select {
					case <-pending.Done():
						v, failure := pending.Result()
						if (failure == nil) != (tc.limit == "") {
							t.Fatal(v, failure)
						}
						if tc.limit == "" && b.Counters().Runs != 1 {
							t.Fatal("paid Send did not run exactly once", b.Counters())
						}
						data, err := json.Marshal(bridgeCanonical(reflect.ValueOf([]any{v, failure, g.Inspect(), a.Counters(), b.Counters()})))
						if err != nil {
							t.Fatal(err)
						}
						o.Values = append(o.Values, string(data))
					default:
						t.Fatal("Send Request did not settle")
					}
				}
				o.Trace = trace.lines
				observations = append(observations, o)
			})
		}
	}
	return observations
}
