package northtalk

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func TestOperationHostFailureAtInterruptedCrossing(t *testing.T) {
	for _, mode := range []Mode{Immediate, Suspending, FireAndForget} {
		for _, interruption := range []string{"none", "cancel", "stop"} {
			for _, failure := range []string{"error", "panic", "malformed Data", "catalogue code", "reserved key", "undeclared code", "invalid result"} {
				if failure == "invalid result" && mode != Immediate {
					continue
				}
				modeName := map[Mode]string{Immediate: "immediate", Suspending: "suspending", FireAndForget: "fire-and-forget"}[mode]
				t.Run(modeName+"/"+interruption+"/"+failure, func(t *testing.T) {
					core := New()
					invoke := func(c *Call) (Value, error) {
						s := c.Group().Script(c.ScriptName())
						switch interruption {
						case "cancel":
							s.CancelRun(c.RunID())
						case "stop":
							s.Stop("crossing")
						}
						switch failure {
						case "panic":
							panic("private Host detail")
						case "malformed Data":
							return Nothing, &ScriptError{Code: "custom", Data: Int(1)}
						case "catalogue code":
							return Nothing, &ScriptError{Code: "timeout", Data: Nothing}
						case "reserved key":
							return Nothing, &ScriptError{Code: "custom", Data: localeMap(t, KV("at", Int(1)))}
						case "undeclared code":
							return Nothing, &ScriptError{Code: "other", Data: Nothing}
						case "invalid result":
							return Nothing, nil
						default:
							return Nothing, errors.New("private Host detail")
						}
					}
					op := Operation{Name: "fail", Mode: mode, Errors: []ErrorDecl{{Code: "custom"}}}
					statement := "tell api to fail"
					switch mode {
					case Immediate:
						op.Result = NumberShape
						op.Do = func(c *Call, _ []Value) (Value, error) { return invoke(c) }
						statement = "ask api to fail"
					case Suspending:
						op.Result = NumberShape
						op.Start = func(c *Call, _ []Value) error { _, err := invoke(c); return err }
						statement = "ask api to fail and wait"
					case FireAndForget:
						op.Fire = func(c *Call, _ []Value) error { _, err := invoke(c); return err }
					}
					def, err := core.DefineCapability(t.Name(), op)
					if err != nil {
						t.Fatal(err)
					}
					var trace lines
					g := core.NewGroup(GroupOptions{Trace: &trace})
					s, err := g.Load(LoadOptions{Name: "s", Grants: map[string]*Grant{"api": def.GrantAll(nil)}, Source: "script variable n=0\non go\n try\n  put 9 into n\n  " + statement + "\n  put 99 into n\n catch \"host error\"\n  put 77 into n\n finally\n  add 1 to n\n end try\nend go"})
					if err != nil {
						t.Fatal(err)
					}
					s.Deliver(Message{Name: "go"})
					r, err := g.Pump(time.Unix(0, 0), PumpOptions{})
					if err != nil {
						t.Fatal(err)
					}
					failures := 0
					for _, report := range r.Reports {
						if _, ok := report.(*CallFailed); ok {
							failures++
						}
					}
					wantFailures, wantN := 0, "0"
					switch interruption {
					case "none":
						wantFailures, wantN = 1, "78"
						if end := joinEnd(t, r, "s"); end.Outcome != Completed {
							t.Fatal(end)
						}
					case "cancel":
						wantN = "1"
						if end := joinEnd(t, r, "s"); end.Outcome != Cancelled {
							t.Fatal(end)
						}
					case "stop":
						if r.State != Stopped {
							t.Fatal(r.State)
						}
					}
					if failures != wantFailures || g.Inspect().Scripts[0].Vars[0].Val.String() != wantN {
						t.Fatalf("CallFailed reports=%d, want %d; vars=%v; trace=%v", failures, wantFailures, g.Inspect(), trace)
					}
					records := strings.Join(trace, "\n")
					if !strings.Contains(records, "call s/r1.c1 op=api.fail args=[] error=") {
						t.Fatal("missing failed call record", trace)
					}
					if interruption != "none" && (strings.Contains(records, "call-failed ") || strings.Contains(records, "raise ")) {
						t.Fatal("interrupted crossing raised or reported a Host failure", trace)
					}
				})
			}
		}
	}
}

func TestOperationHostFailureDuringCancellationCleanup(t *testing.T) {
	core := New()
	def, err := core.DefineCapability(t.Name(),
		Operation{Name: "cancel", Mode: Immediate, Result: NumberShape, Do: func(c *Call, _ []Value) (Value, error) {
			c.Group().Script(c.ScriptName()).CancelRun(c.RunID())
			return Int(1), nil
		}},
		Operation{Name: "fail", Mode: Immediate, Result: NumberShape, Do: func(*Call, []Value) (Value, error) {
			return Nothing, errors.New("cleanup Host failure")
		}},
	)
	if err != nil {
		t.Fatal(err)
	}
	var trace lines
	g := core.NewGroup(GroupOptions{Trace: &trace})
	s, err := g.Load(LoadOptions{Name: "s", Grants: map[string]*Grant{"api": def.GrantAll(nil)}, Source: "on go\n try\n  ask api to cancel\n finally\n  ask api to fail\n end try\nend go"})
	if err != nil {
		t.Fatal(err)
	}
	s.Deliver(Message{Name: "go"})
	r, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	end := joinEnd(t, r, "s")
	failures := 0
	for _, report := range r.Reports {
		if failed, ok := report.(*CallFailed); ok {
			failures++
			if failed.Detail != "cleanup Host failure" {
				t.Fatal(failed)
			}
		}
	}
	records := strings.Join(trace, "\n")
	if end.Outcome != Cancelled || failures != 1 || !strings.Contains(records, `raise s/r1 code="host error"`) || !strings.Contains(records, `cleanup-failed s/r1 code="host error"`) {
		t.Fatal(end, failures, trace)
	}
}
