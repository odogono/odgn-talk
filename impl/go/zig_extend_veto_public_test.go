package northtalk_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"testing"
	"time"

	talk "northtalk.org/go"
)

// The shared public Host compares refusal diagnostics and the unchanged live
// Script with a separately compiled native Go Host (#1060).
func runExtendVetoBridgeCases(t *testing.T) []bridgeObservation {
	t.Helper()
	var out []bridgeObservation
	for _, tc := range []struct{ name, caller string }{
		{"command", "guarded"},
		{"function style", "return guarded()"},
		{"lambda", "return given: guarded()"},
		{"transitive", "helper\nend caller\non helper\n guarded"},
		{"repeated calls", "guarded\n guarded\n return guarded()"},
	} {
		for _, inExtension := range []bool{false, true} {
			name := fmt.Sprintf("extend veto %s/extension=%t", tc.name, inExtension)
			t.Run(name, func(t *testing.T) {
				o := bridgeObservation{Name: name}
				var trace bridgeTrace
				g := talk.New().NewGroup(talk.GroupOptions{Name: "g", Trace: &trace})
				value := func(v any) {
					b, err := json.Marshal(bridgeCanonical(reflect.ValueOf(v)))
					if err != nil {
						t.Fatal(err)
					}
					o.Values = append(o.Values, string(b))
				}
				pump := func(at time.Time) {
					r, err := g.Pump(at, talk.PumpOptions{})
					if err != nil {
						t.Fatal(err)
					}
					o.Pumps = append(o.Pumps, bridgeCanonical(reflect.ValueOf(r)))
					value(g.Inspect())
				}
				guarded := "on guarded, deciding\n veto \"blocked\"\nend guarded"
				base := "script variable n = 3\non hold\n wait 1 s\n add 1 to n\n return n\nend hold\n"
				if !inExtension {
					base += guarded
				}
				s, err := g.Load(talk.LoadOptions{Name: "s", Source: base})
				if err != nil {
					t.Fatal(err)
				}
				if inExtension {
					if err := s.Extend(guarded); err != nil {
						t.Fatal(err)
					}
				}
				_, held, err := s.Request(nil, talk.Message{Name: "hold"})
				if err != nil {
					t.Fatal(err)
				}
				pump(bridgeNow)
				before := g.Fingerprint()
				// Two refusals must not add declarations or consume a code-unit id.
				for range 2 {
					err := s.Extend("script variable rejected = 99\non caller\n " + tc.caller + "\nend")
					var load *talk.LoadError
					if !errors.As(err, &load) || len(load.Diagnostics) != 1 {
						t.Fatalf("expected one veto diagnostic, got %v", err)
					}
					d := load.Diagnostics[0]
					unit, line := "s+1", 8
					if inExtension {
						unit, line = "s+2", 2
					}
					if d.Code != "veto outside a decision" || d.Unit != unit || d.Line != line || d.Col != 2 {
						t.Fatalf("wrong veto diagnostic: %+v", d)
					}
					value(load)
					value(g.Inspect())
					if g.Fingerprint() != before {
						t.Fatal("refused extension changed code identity")
					}
				}
				// An unrelated extension remains legal, and the inherited Handler
				// still vetoes a Host Decision after the refused local calls.
				if err := s.Extend("on safe\n return n\nend safe"); err != nil {
					t.Fatal(err)
				}
				_, deciding, err := s.Decide(nil, talk.Message{Name: "guarded"})
				if err != nil {
					t.Fatal(err)
				}
				pump(bridgeNow)
				select {
				case <-deciding.Done():
					value(deciding.Decided())
				default:
					t.Fatal("Decision did not settle")
				}
				select {
				case <-held.Done():
					t.Fatal("Extend ended the waiting Run")
				default:
					o.Values = append(o.Values, "open")
				}
				pump(bridgeNow.Add(time.Second))
				select {
				case <-held.Done():
					v, failure := held.Result()
					if failure != nil || !v.Equal(talk.Int(4)) {
						t.Fatal(v, failure)
					}
					value([]any{v, failure})
				default:
					t.Fatal("waiting Run did not resume")
				}
				o.Trace = trace.lines
				out = append(out, o)
			})
		}
	}
	return out
}

func TestExtendVetoBridge(t *testing.T) { runExtendVetoBridgeCases(t) }
