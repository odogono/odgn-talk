package northtalk_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	talk "github.com/odogono/odgn-talk/impl/go"
)

// Public replacements for native hooks triaged in #1048. These observations
// are compared to a separately compiled native Go Host, including all reports,
// Fuel, Trace, pending results and inspected state.
func runTriageBridgeCases(t *testing.T) []bridgeObservation {
	t.Helper()
	var out []bridgeObservation
	for _, name := range []string{"broadcast during pump", "wait cancel committed", "wait cancel rollback", "wait cancel order", "clock refusal", "malformed immediate", "malformed start", "malformed fail"} {
		t.Run(name, func(t *testing.T) {
			o := bridgeObservation{Name: "triage " + name}
			var trace bridgeTrace
			core := talk.New()
			g := core.NewGroup(talk.GroupOptions{Name: "g", Trace: &trace})
			value := func(v any) {
				data, err := json.Marshal(bridgeCanonical(reflect.ValueOf(v)))
				if err != nil {
					t.Fatal(err)
				}
				o.Values = append(o.Values, string(data))
			}
			pump := func(at time.Time) {
				r, err := g.Pump(at, talk.PumpOptions{})
				if err != nil {
					t.Fatal(err)
				}
				for _, report := range r.Reports {
					if failed, ok := report.(*talk.CallFailed); ok && failed.Detail == "" {
						t.Fatal("CallFailed lost Host detail", failed)
					}
				}
				o.Pumps = append(o.Pumps, bridgeCanonical(reflect.ValueOf(r)))
				value(g.Inspect())
			}
			load := func(source string, limits talk.Limits, grants map[string]*talk.Grant) *talk.Script {
				s, err := g.Load(talk.LoadOptions{Name: "s", Source: source, Limits: limits, Grants: grants})
				if err != nil {
					t.Fatal(err)
				}
				return s
			}
			request := func(s *talk.Script, m string) *talk.Pending {
				_, p, err := s.Request(nil, talk.Message{Name: m})
				if err != nil {
					t.Fatal(err)
				}
				return p
			}
			settled := func(p *talk.Pending) {
				select {
				case <-p.Done():
					v, e := p.Result()
					value([]any{v, e})
				default:
					o.Values = append(o.Values, "open")
				}
			}
			switch name {
			case "broadcast during pump":
				s := load("on go\n return 7\nend go", talk.Limits{}, nil)
				queued := false
				trace.record = func(line string) {
					if !queued && strings.HasPrefix(line, "seg ") {
						queued = true
						id, err := g.Broadcast(talk.Message{Name: "go"})
						if err != nil {
							t.Fatal(err)
						}
						o.Calls = append(o.Calls, string(id))
					}
				}
				p := request(s, "go")
				pump(bridgeNow)
				settled(p)
				pump(bridgeNow)
				value(s.Counters())
			case "wait cancel committed", "wait cancel rollback", "wait cancel order":
				limits := talk.Limits{}
				if name == "wait cancel rollback" {
					limits.CleanupBudget = 1
				}
				s := load("script variable a = 0\nscript variable seen = []\non nap\n try\n  put 1 into a\n  wait 1 s\n finally\n  put 2 into a\n  put \"cleanup\" after seen\n end try\nend nap\non mark\n put 7 into a\n put \"mark\" after seen\nend mark", limits, nil)
				p := request(s, "nap")
				pump(bridgeNow)
				settled(p)
				if name == "wait cancel order" {
					s.CancelRun(g.Inspect().Scripts[0].Runs[0].ID)
					request(s, "mark")
				} else {
					mark := request(s, "mark")
					if name == "wait cancel committed" {
						pump(bridgeNow)
						settled(mark)
					}
					s.CancelRun(g.Inspect().Scripts[0].Runs[0].ID)
				}
				pump(bridgeNow)
				settled(p)
				pump(bridgeNow.Add(time.Second))
				value(s.Counters())
			case "clock refusal":
				s := load("on go\n return 7\nend go", talk.Limits{}, nil)
				p := request(s, "go")
				for _, at := range []time.Time{time.Date(0, 1, 1, 0, 0, 0, 0, time.UTC), time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC), time.Date(292277024627, 1, 1, 0, 0, 0, 0, time.UTC), time.Date(1, 1, 1, 0, 0, 0, 0, time.FixedZone("east", 3600))} {
					r, err := g.Pump(at, talk.PumpOptions{FuelSlice: 3, FuelCap: 7})
					var host *talk.HostError
					if !errors.As(err, &host) || host.Code != talk.InvalidValue {
						t.Fatal(r, err)
					}
					value(host.Code)
					o.Pumps = append(o.Pumps, bridgeCanonical(reflect.ValueOf(r)))
					settled(p)
					value(g.Inspect())
				}
				pump(bridgeNow)
				settled(p)
			default:
				for i, data := range []talk.Value{talk.Int(7), talk.List(talk.Int(1)), talk.Bool(true), triageMap(t, "code", talk.Int(1)), triageMap(t, "message", talk.Int(1)), triageMap(t, "at", talk.Int(1))} {
					if i > 0 {
						g = core.NewGroup(talk.GroupOptions{Name: "g", Trace: &trace})
					}
					var call *talk.Call
					failure := &talk.ScriptError{Code: "custom", Message: "Host detail", Data: data}
					op := talk.Operation{Name: "read", Mode: talk.Immediate, Result: talk.NumberShape, Do: func(*talk.Call, []talk.Value) (talk.Value, error) { return talk.Nothing, failure }}
					source := "on go\n ask api to read\nend go"
					if name != "malformed immediate" {
						op.Mode = talk.Suspending
						op.Do = nil
						op.Start = func(c *talk.Call, _ []talk.Value) error {
							call = c
							if name == "malformed start" {
								return failure
							}
							return nil
						}
						source = "on go\n ask api to read and wait\nend go"
					}
					def, err := core.DefineCapability(fmt.Sprintf("service%d", i), op)
					if err != nil {
						t.Fatal(err)
					}
					s := load(source, talk.Limits{}, map[string]*talk.Grant{"api": def.GrantAll(nil)})
					p := request(s, "go")
					pump(bridgeNow)
					settled(p)
					if name == "malformed fail" {
						call.Fail(failure)
						pump(bridgeNow)
						settled(p)
					}
				}
			}
			o.Trace = trace.lines
			out = append(out, o)
		})
	}
	return out
}

func triageMap(t *testing.T, key string, v talk.Value) talk.Value {
	t.Helper()
	m, err := talk.Map(talk.KV(key, v))
	if err != nil {
		t.Fatal(err)
	}
	return m
}
