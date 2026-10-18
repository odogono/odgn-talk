package northtalk_test

import (
	"fmt"
	"reflect"
	"testing"

	talk "github.com/odogono/odgn-talk/impl/go"
)

// Captures distinguish the original Function Value from a display-only stand-in.
// The nested error Handler reads during both locally and through a Lambda.
func functionErrorDuringSource(named bool) string {
	body := ` put given x
  throw {code: "mine", value: captured + x}
 end given into original`
	if named {
		body = " put fail into original"
	}
	return `script variable original
script variable saved
script variable caught
on exported captured
` + body + `
 return original
end exported
function fail x
 throw {code: "mine", value: x}
end fail
on error "mine" where the fn of msg = original, during msg
 put given: msg into saved
 forward
end error
on forward
 error {code: "local"}
end forward
on error "local" where false, during msg
 throw "unreachable"
end error
on error "local", during msg
 put [msg, saved()] into caught
end error
`
}

// startFunctionError creates the captured Function and calls it with 7, either
// from the Host or from a foreign Script.
func startFunctionError(t *testing.T, g *talk.Group, named, foreign bool, pump func()) *talk.Pending {
	t.Helper()
	s, err := g.Load(talk.LoadOptions{Name: "s", Source: functionErrorDuringSource(named)})
	if err != nil {
		t.Fatal(err)
	}
	_, made, err := s.Request(nil, talk.Message{Name: "exported", Args: []talk.Value{talk.Int(11)}})
	if err != nil {
		t.Fatal(err)
	}
	pump()
	fn, failure := made.Result()
	if failure != nil {
		t.Fatal(failure)
	}
	var pending *talk.Pending
	if foreign {
		caller, err := g.Load(talk.LoadOptions{Name: "caller", Source: "on go f\n f(7) and wait\nend go\n"})
		if err != nil {
			t.Fatal(err)
		}
		_, pending, err = caller.Request(nil, talk.Message{Name: "go", Args: []talk.Value{fn}})
		if err != nil {
			t.Fatal(err)
		}
	} else if _, pending, err = g.Call(nil, fn, []talk.Value{talk.Int(7)}, nil); err != nil {
		t.Fatal(err)
	}
	return pending
}

// checkFunctionErrorDuring returns the retained Function from the caught metadata.
func checkFunctionErrorDuring(t *testing.T, g *talk.Group) talk.Value {
	t.Helper()
	vars := g.Inspect().Scripts[0].Vars
	fn, caught := vars[0].Val, vars[2].Val
	for _, i := range []int{1, 2} {
		msg := caught.Index(i)
		if len(msg.Entries()) != 2 || !msg.Get("fn").Equal(fn) || msg.Get("args").String() != "[7]" {
			t.Fatalf("during = %s; want {fn: %s, args: [7]}", msg, fn)
		}
	}
	return caught.Index(1).Get("fn")
}

func TestFunctionErrorDuringRetainsFunctionValue(t *testing.T) {
	runFunctionErrorDuringBridgeCases(t)
}

// These observations are also diffed against a separately compiled native Host.
func runFunctionErrorDuringBridgeCases(t *testing.T) []bridgeObservation {
	t.Helper()
	var out []bridgeObservation
	for _, named := range []bool{false, true} {
		for _, foreign := range []bool{false, true} {
			for _, slice := range []int64{0, 1} {
				name := fmt.Sprintf("function error named %t foreign %t slice %d", named, foreign, slice)
				t.Run(name, func(t *testing.T) {
					o := bridgeObservation{Name: name}
					var trace bridgeTrace
					g := talk.New().NewGroup(talk.GroupOptions{Name: "g", Trace: &trace})
					record := func(v any) { o.Pumps = append(o.Pumps, bridgeCanonical(reflect.ValueOf(v))) }
					pump := func(opts talk.PumpOptions) talk.GroupState {
						r, err := g.Pump(bridgeNow, opts)
						if err != nil {
							t.Fatal(err)
						}
						record(r)
						record(g.Inspect())
						return r.State
					}
					pending := startFunctionError(t, g, named, foreign, func() { pump(talk.PumpOptions{}) })
					idle := false
					for range 300 {
						state := pump(talk.PumpOptions{FuelSlice: slice, FuelCap: slice})
						select {
						case <-pending.Done():
							v, failure := pending.Result()
							record([]any{v, failure})
						default:
							o.Values = append(o.Values, "open")
						}
						if idle = state == talk.Idle; idle {
							break
						}
					}
					if !idle {
						t.Fatal("Function error Runs did not finish")
					}
					select {
					case <-pending.Done():
					default:
						t.Fatal("Function future did not settle")
					}
					_, failure := pending.Result()
					if failure == nil || failure.Code != "send failed" || failure.Data.Get("reason").String() != `"errored"` {
						t.Fatalf("unexpected Function failure: %v", failure)
					}
					// The retained field must still be callable, with the captured data.
					retained := checkFunctionErrorDuring(t, g)
					_, again, err := g.Call(nil, retained, []talk.Value{talk.Int(7)}, nil)
					if err != nil {
						t.Fatal(err)
					}
					pump(talk.PumpOptions{})
					_, failure = again.Result()
					want := "18"
					if named {
						want = "7"
					}
					if failure == nil || failure.Data.Get("error").Get("value").String() != want {
						t.Fatal(failure)
					}
					o.Trace = trace.lines
					out = append(out, o)
				})
			}
		}
	}
	return out
}

// Restoring after every instruction boundary covers the failed Function Run,
// its queued error metadata, dispatch, local calls and captured during values.
func TestFunctionErrorDuringSaveEveryBoundary(t *testing.T) {
	for _, named := range []bool{false, true} {
		for _, foreign := range []bool{false, true} {
			t.Run(fmt.Sprintf("named %t foreign %t", named, foreign), func(t *testing.T) {
				core := talk.New()
				var originalTrace, restoredTrace bridgeTrace
				g := core.NewGroup(talk.GroupOptions{Name: "g", Trace: &originalTrace})
				startFunctionError(t, g, named, foreign, func() {
					if _, err := g.Pump(bridgeNow, talk.PumpOptions{}); err != nil {
						t.Fatal(err)
					}
				})
				canonical := func(v any) any { return bridgeCanonical(reflect.ValueOf(v)) }
				queued := false
				for step := range 300 {
					saved, err := g.Save()
					if err != nil {
						t.Fatal(err)
					}
					copy, _, err := core.Restore(saved, talk.RestoreOptions{Name: "g", Trace: &restoredTrace})
					if err != nil {
						t.Fatalf("restore at %d: %v", step, err)
					}
					originalTrace.lines, restoredTrace.lines = nil, nil
					opts := talk.PumpOptions{FuelSlice: 1, FuelCap: 1}
					a, err := g.Pump(bridgeNow, opts)
					if err != nil {
						t.Fatal(err)
					}
					b, err := copy.Pump(bridgeNow, opts)
					if err != nil {
						t.Fatal(err)
					}
					// Restore detaches Host future accounting, so compare operational Reports.
					a.Reports, b.Reports = talk.OperationalReports(a.Reports), talk.OperationalReports(b.Reports)
					if !reflect.DeepEqual(canonical(a), canonical(b)) || !reflect.DeepEqual(canonical(g.Inspect()), canonical(copy.Inspect())) || !reflect.DeepEqual(originalTrace.lines, restoredTrace.lines) {
						t.Fatalf("restored step %d differs\noriginal=%+v\nrestored=%+v\ntrace=%v / %v", step, a, b, originalTrace.lines, restoredTrace.lines)
					}
					view := g.Inspect().Scripts[0]
					if len(view.Mailbox) > 0 && view.Mailbox[0].Message.Name == "error" {
						queued = true
					}
					if a.State == talk.Idle {
						if !queued {
							t.Fatal("did not cover queued error metadata")
						}
						checkFunctionErrorDuring(t, g)
						checkFunctionErrorDuring(t, copy)
						return
					}
				}
				t.Fatal("Function error Runs did not finish")
			})
		}
	}
}
