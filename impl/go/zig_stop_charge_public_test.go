package northtalk_test

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"

	talk "northtalk.org/go"
)

// Exercise real public callbacks on both separately compiled Cores (#1065).
func runStopChargeBridgeCases(t *testing.T) []bridgeObservation {
	t.Helper()
	var observations []bridgeObservation
	for _, mode := range []talk.Mode{talk.Immediate, talk.Suspending, talk.FireAndForget} {
		for _, prefix := range []int64{0, 5} {
			for _, traceStop := range []bool{false, true} {
				name := fmt.Sprintf("failed charge stop mode=%v prefix=%d trace=%t", mode, prefix, traceStop)
				t.Run(name, func(t *testing.T) {
					o := bridgeObservation{Name: name}
					var trace bridgeTrace
					core := talk.New()
					g := core.NewGroup(talk.GroupOptions{Name: "g", Trace: &trace})
					var s *talk.Script
					callback := func(call *talk.Call) error {
						o.Calls = append(o.Calls, string(call.ID()))
						if !traceStop {
							s.Stop("requested")
						}
						if err := call.Charge(prefix); err != nil {
							t.Fatal(err)
						}
						err := call.Charge(100000)
						if err == nil {
							t.Fatal("oversized Charge succeeded")
						}
						return err
					}
					op := talk.Operation{Name: "finish", Mode: mode, Result: talk.NumberShape}
					statement := "ask api to finish"
					switch mode {
					case talk.Immediate:
						op.Do = func(c *talk.Call, _ []talk.Value) (talk.Value, error) {
							return talk.Nothing, callback(c)
						}
					case talk.Suspending:
						op.Start = func(c *talk.Call, _ []talk.Value) error { return callback(c) }
						statement += " and wait"
					case talk.FireAndForget:
						op.Fire = func(c *talk.Call, _ []talk.Value) error { return callback(c) }
						op.Result = talk.NothingShape
						statement = "tell api to finish"
					}
					def, err := core.DefineCapability("api", op)
					if err != nil {
						t.Fatal(err)
					}
					s, err = g.Load(talk.LoadOptions{Name: "s", Source: "script variable n = 0\non go\n try\n put 9 into n\n" + statement + "\n put 8 into n\n finally\n put 3 into n\n end try\nend go\n", Limits: talk.Limits{FuelPerRun: 100}, Grants: map[string]*talk.Grant{"api": def.GrantAll(nil)}})
					if err != nil {
						t.Fatal(err)
					}
					if traceStop {
						trace.record = func(line string) {
							if strings.HasPrefix(line, "call ") {
								s.Stop("requested")
							}
						}
					}
					value := func(v any) {
						data, err := json.Marshal(bridgeCanonical(reflect.ValueOf(v)))
						if err != nil {
							t.Fatal(err)
						}
						o.Values = append(o.Values, string(data))
					}
					for i := range 2 {
						_, pending, err := s.Request(nil, talk.Message{Name: "go"})
						if err != nil {
							t.Fatal(err)
						}
						r, err := g.Pump(bridgeNow, talk.PumpOptions{})
						if err != nil || r.State != talk.Stopped {
							t.Fatal(r, err)
						}
						stops := 0
						for _, report := range r.Reports {
							switch report := report.(type) {
							case *talk.Stop:
								stops++
								if report.Reason != "requested" || (i == 0 && len(report.DiscardedRuns) != 1) {
									t.Fatal(report)
								}
							case *talk.RunEnd, *talk.CallFailed:
								t.Fatalf("Stop crossing produced %T: %+v", report, report)
							}
						}
						if stops != 1 || (i == 1 && r.FuelUsed != 0) {
							t.Fatal(r)
						}
						o.Pumps = append(o.Pumps, bridgeCanonical(reflect.ValueOf(r)))
						select {
						case <-pending.Done():
							result, failure := pending.Result()
							if failure == nil {
								t.Fatal("stopped Request succeeded")
							}
							value([]any{result, failure})
						default:
							t.Fatal("stopped Request did not settle")
						}
						view := g.Inspect()
						if view.Scripts[0].Vars[0].Val.String() != "0" {
							t.Fatal(view)
						}
						value(view)
						value(s.Counters())
						s.Stop("later")
					}
					if len(o.Calls) != 1 {
						t.Fatal(o.Calls)
					}
					o.Trace = trace.lines
					observations = append(observations, o)
				})
			}
		}
	}
	// Adjacent controls must retain their existing refusal semantics too:
	// cancellation fails cleanup; Rewind discards the Run and keeps its Delivery.
	for _, control := range []string{"cancel", "rewind"} {
		t.Run("failed charge "+control, func(t *testing.T) {
			o := bridgeObservation{Name: "failed charge " + control}
			var trace bridgeTrace
			core := talk.New()
			def, err := core.DefineCapability("api", talk.Operation{Name: "finish", Result: talk.NumberShape, Do: func(c *talk.Call, _ []talk.Value) (talk.Value, error) {
				o.Calls = append(o.Calls, string(c.ID()))
				s := c.Group().Script(c.ScriptName())
				if control == "cancel" {
					s.CancelRun(c.RunID())
				} else {
					s.RewindRun(c.RunID())
				}
				if err := c.Charge(5); err != nil {
					t.Fatal(err)
				}
				return talk.Nothing, c.Charge(100000)
			}})
			if err != nil {
				t.Fatal(err)
			}
			g := core.NewGroup(talk.GroupOptions{Name: "g", Trace: &trace})
			s, err := g.Load(talk.LoadOptions{Name: "s", Source: "script variable n = 0\non go\ntry\nput 9 into n\nask api to finish\nfinally\nput 3 into n\nend try\nend go\n", Limits: talk.Limits{FuelPerRun: 100}, Grants: map[string]*talk.Grant{"api": def.GrantAll(nil)}})
			if err != nil {
				t.Fatal(err)
			}
			_, pending, err := s.Request(nil, talk.Message{Name: "go"})
			if err != nil {
				t.Fatal(err)
			}
			r, err := g.Pump(bridgeNow, talk.PumpOptions{})
			if err != nil {
				t.Fatal(err)
			}
			o.Pumps = append(o.Pumps, bridgeCanonical(reflect.ValueOf(r)))
			values := []any{g.Inspect(), s.Counters()}
			select {
			case <-pending.Done():
				v, failure := pending.Result()
				values = append(values, v, failure)
			default:
				values = append(values, "open")
			}
			data, err := json.Marshal(bridgeCanonical(reflect.ValueOf(values)))
			if err != nil {
				t.Fatal(err)
			}
			o.Values = append(o.Values, string(data))
			o.Trace = trace.lines
			observations = append(observations, o)
		})
	}
	return observations
}
