package northtalk_test

import (
	"encoding/json"
	"fmt"
	"reflect"
	"testing"

	talk "github.com/odogono/odgn-talk/impl/go"
)

// The same public Host runs in the separately compiled native reference and
// tagged backend. Keep Trace, Fuel, typed reports, futures and inspected state.
func runErrorDuringBridgeCases(t *testing.T) []bridgeObservation {
	t.Helper()
	var out []bridgeObservation
	for _, origin := range []string{"Host", "message"} {
		for _, slice := range []int64{0, 1} {
			name := fmt.Sprintf("error during %s slice %d", origin, slice)
			t.Run(name, func(t *testing.T) {
				o := bridgeObservation{Name: name}
				var trace bridgeTrace
				g := talk.New().NewGroup(talk.GroupOptions{Name: "g", Trace: &trace})
				s, err := g.Load(talk.LoadOptions{Name: "s", Source: `script variable fn
script variable caught
on fail x
  throw "mine"
end fail
on error "mine", during msg
  put given: msg into fn
  forward
end error
on forward
  error {code: "local"}
end forward
on error "local" where false, during msg
  throw "unreachable"
end error
on error "local", during msg
  put [msg, fn()] into caught
end error
`})
				if err != nil {
					t.Fatal(err)
				}
				value := func(v any) {
					data, err := json.Marshal(bridgeCanonical(reflect.ValueOf(v)))
					if err != nil {
						t.Fatal(err)
					}
					o.Values = append(o.Values, string(data))
				}
				settled := func(p *talk.Pending) {
					select {
					case <-p.Done():
						v, err := p.Result()
						value([]any{v, err})
					default:
						o.Values = append(o.Values, "open")
					}
				}
				drain := func(p *talk.Pending) {
					for range 200 {
						r, err := g.Pump(bridgeNow, talk.PumpOptions{FuelSlice: slice, FuelCap: slice})
						if err != nil {
							t.Fatal(err)
						}
						o.Pumps = append(o.Pumps, bridgeCanonical(reflect.ValueOf(r)))
						settled(p)
						view := g.Inspect()
						value(view)
						if len(view.Scripts[0].Runs) == 0 && len(view.Scripts[0].Mailbox) == 0 {
							return
						}
					}
					t.Fatal("error Run did not finish")
				}
				var p *talk.Pending
				expected := `[nothing, nothing]`
				switch origin {
				case "Host":
					_, p, err = s.Request(nil, talk.Message{Name: "error", Args: []talk.Value{triageMap(t, "code", bridgeText("mine"))}})
				case "message":
					_, p, err = s.Request(nil, talk.Message{Name: "fail", Args: []talk.Value{talk.Int(7)}})
					expected = `[{name: "fail", args: [7]}, {name: "fail", args: [7]}]`
				}
				if err != nil {
					t.Fatal(err)
				}
				drain(p)
				if got := g.Inspect().Scripts[0].Vars[1].Val.String(); got != expected {
					t.Fatalf("caught %s, want %s", got, expected)
				}
				o.Trace = trace.lines
				out = append(out, o)
			})
		}
	}
	return out
}
