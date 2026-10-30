package northtalk_test

import (
	"fmt"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"

	talk "northtalk.org/go"
)

func TestCallSettlementOwnership(t *testing.T) {
	runSettlementBridgeCases(t)
}

// The shared Host compares admission, queue integrity and returned failures
// against a separately compiled native Core, including Trace and all accounting.
func runSettlementBridgeCases(t *testing.T) []bridgeObservation {
	t.Helper()
	core := talk.New()
	other := core.NewGroup(talk.GroupOptions{})
	kind, err := core.DefineObjectKind(talk.ObjectKindDef{Name: "item"})
	if err != nil {
		t.Fatal(err)
	}
	object, err := other.Object(kind, "foreign", nil)
	if err != nil {
		t.Fatal(err)
	}
	foreign, err := other.Load(talk.LoadOptions{Name: "foreign", Source: "on export\n return given: 1\nend export"})
	if err != nil {
		t.Fatal(err)
	}
	_, exported, err := foreign.Request(nil, talk.Message{Name: "export"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = other.Pump(bridgeNow, talk.PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	fn, failure := exported.Result()
	if failure != nil || fn.Kind() != talk.KindFunction {
		t.Fatal(fn, failure)
	}
	var out []bridgeObservation
	for i, foreignValue := range []talk.Value{fn, object.Value()} {
		for _, container := range []string{"direct", "list", "map", "envelope collision"} {
			bad := foreignValue
			switch container {
			case "list":
				bad = talk.List(talk.Int(1), triageMap(t, "nested", talk.List(bad)))
			case "map":
				bad = triageMap(t, "nested", talk.List(triageMap(t, "payload", bad)))
			case "envelope collision":
				bad = triageMap(t, "code", bad)
			}
			for _, completion := range []string{"answer", "answer cost", "fail", "immediate result", "immediate failure", "start failure"} {
				name := fmt.Sprintf("settlement %d/%s/%s", i, container, completion)
				t.Run(name, func(t *testing.T) {
					o := bridgeObservation{Name: name}
					var trace bridgeTrace
					var ready atomic.Int32
					g := core.NewGroup(talk.GroupOptions{Trace: &trace, OnReady: func() { ready.Add(1) }})
					var call *talk.Call
					failure := &talk.ScriptError{Code: "custom", Data: bad}
					queued := completion == "answer" || completion == "answer cost" || completion == "fail"
					reject := func(c *talk.Call) {
						before := ready.Load()
						func() {
							defer func() {
								host, ok := recover().(*talk.HostError)
								if !ok || host.Code != talk.WrongGroup {
									t.Errorf("foreign settlement must panic WrongGroup: %v", host)
									return
								}
								o.Values = append(o.Values, string(host.Code))
							}()
							switch completion {
							case "answer":
								c.Answer(bad)
							case "answer cost":
								c.AnswerWithCost(bad, 1000)
							case "fail":
								c.Fail(failure)
							}
						}()
						if ready.Load() != before {
							t.Error("foreign settlement notified OnReady")
						}
					}
					op := talk.Operation{Name: "read", Result: talk.ValueShape, Do: func(*talk.Call, []talk.Value) (talk.Value, error) {
						if completion == "immediate result" {
							return bad, nil
						}
						return talk.Nothing, failure
					}}
					wait := ""
					if queued || completion == "start failure" {
						wait = " and wait"
						op.Mode, op.Do = talk.Suspending, nil
						op.Start = func(c *talk.Call, _ []talk.Value) error {
							call = c
							if !queued {
								return failure
							}
							reject(c)
							return nil
						}
					}
					def, err := core.DefineCapability("service", op)
					if err != nil {
						t.Fatal(err)
					}
					s, err := g.Load(talk.LoadOptions{Name: "s", Source: "script variable seen = 0\non go\n ask api to read" + wait + "\n put it into seen\n return it\nend go", Grants: map[string]*talk.Grant{"api": def.GrantAll(nil)}})
					if err != nil {
						t.Fatal(err)
					}
					_, p, err := s.Request(nil, talk.Message{Name: "go"})
					if err != nil {
						t.Fatal(err)
					}
					pump := func() {
						r, err := g.Pump(bridgeNow, talk.PumpOptions{})
						if err != nil {
							t.Fatal(err)
						}
						for _, report := range r.Reports {
							o.Calls = append(o.Calls, fmt.Sprintf("%T", report))
							if f, ok := report.(*talk.CallFailed); ok && f.Detail == "" {
								t.Error("missing Host failure detail")
							}
						}
						o.Pumps = append(o.Pumps, bridgeCanonical(reflect.ValueOf(r)))
						o.Pumps = append(o.Pumps, bridgeCanonical(reflect.ValueOf(g.Inspect())))
					}
					pump()
					if queued {
						// Repeat from a worker goroutine after Start has returned.
						done := make(chan struct{})
						go func() { defer close(done); reject(call) }()
						<-done
						pump()
						select {
						case <-p.Done():
							t.Fatal("rejected settlement ended the waiting Request")
						default:
							o.Values = append(o.Values, "open")
						}
						if call.Context().Err() != nil || strings.Contains(strings.Join(trace.lines, "\n"), "> answer ") || strings.Contains(strings.Join(trace.lines, "\n"), "> fail ") {
							t.Fatal("rejected settlement was queued or abandoned the Call", trace.lines)
						}
						if completion == "fail" {
							call.Fail(&talk.ScriptError{Code: "valid", Data: triageMap(t, "value", talk.Int(9))})
						} else {
							call.AnswerWithCost(talk.Int(9), 5)
						}
						pump()
					}
					select {
					case <-p.Done():
					default:
						t.Fatal("valid settlement or returned failure did not finish")
					}
					v, e := p.Result()
					if queued && completion != "fail" {
						if e != nil || !v.Equal(talk.Int(9)) {
							t.Fatal("valid answer lost after rejection", v, e)
						}
					} else {
						want := "host error"
						if queued {
							want = "valid"
						}
						if e == nil || e.Data.Get("error").Get("code").String() != fmt.Sprintf("%q", want) {
							t.Fatal("wrong Request failure", e)
						}
					}
					o.Pumps = append(o.Pumps, bridgeCanonical(reflect.ValueOf([]any{v, e})))
					o.Trace = trace.lines
					out = append(out, o)
				})
			}
		}
	}
	return out
}
