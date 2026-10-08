package northtalk

import (
	"strings"
	"testing"

	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
)

// Exercise errors returned by Do/Start and queued through Fail on a later Pump.
func operationFailureRun(t *testing.T, completion string, failure *ScriptError, limits Limits) (*RunEnd, PumpResult, lines) {
	t.Helper()
	core := New()
	var call *Call
	op := Operation{Name: "fetch", Mode: Immediate, Result: NumberShape, Do: func(*Call, []Value) (Value, error) { return Nothing, failure }}
	source := "on go\n ask api to fetch\nend go"
	if completion != "immediate" {
		op.Mode = Suspending
		op.Do = nil
		op.Start = func(c *Call, _ []Value) error {
			call = c
			if completion == "start" {
				return failure
			}
			return nil
		}
		source = "on go\n ask api to fetch and wait\nend go"
	}
	def, err := core.DefineCapability("service", op)
	if err != nil {
		t.Fatal(err)
	}
	var trace lines
	g := core.NewGroup(GroupOptions{Trace: &trace})
	s, err := g.Load(LoadOptions{Name: "s", Source: source, Grants: map[string]*Grant{"api": def.GrantAll(nil)}, Limits: limits})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Deliver(Message{Name: "go"}); err != nil {
		t.Fatal(err)
	}
	result := joinPump(t, g, 0, PumpOptions{})
	if completion == "fail" {
		if call == nil || len(operationalReports(result.Reports)) != 0 {
			t.Fatal("call did not suspend", result)
		}
		call.Fail(failure)
		result = joinPump(t, g, 1, PumpOptions{})
	}
	return joinEnd(t, result, "s"), result, trace
}

func TestOperationMalformedFailureData(t *testing.T) {
	other := New()
	kind := objectKindForTest(t, other, "light")
	foreign, err := other.NewGroup(GroupOptions{}).Object(kind, "foreign", nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, completion := range []string{"immediate", "start", "fail"} {
		for _, test := range []struct {
			name           string
			data           Value
			emptyTrace     bool
			withoutMessage bool
		}{
			{"number", Int(123), true, false},
			{"text", mustPublicText("private payload"), true, false},
			{"list", List(Int(1)), true, false},
			{"boolean", Bool(true), true, false},
			{"foreign Object", foreign.Value(), true, false},
			{"nested foreign Object", localeMap(t, KV("payload", foreign.Value())), true, false},
			{"code collision", localeMap(t, KV("code", mustPublicText("replacement"))), true, false},
			{"message collision", localeMap(t, KV("message", mustPublicText("replacement"))), true, false},
			{"reserved location", localeMap(t, KV("at", Int(9))), false, false},
			{"reserved message without envelope collision", localeMap(t, KV("message", mustPublicText("replacement"))), false, true},
		} {
			t.Run(completion+"/"+test.name, func(t *testing.T) {
				message := "private Host detail"
				if test.withoutMessage {
					message = ""
				}
				end, result, trace := operationFailureRun(t, completion, &ScriptError{Code: "fetch failed", Message: message, Data: test.data}, Limits{})
				if end.Outcome != Errored || end.Error == nil || end.Error.Code != "host error" || end.At.Line != 2 || end.Error.Data.Get("capability").String() != `"api"` || end.Error.Data.Get("operation").String() != `"fetch"` {
					t.Fatalf("malformed Data did not become host error: %+v", end)
				}
				failures := 0
				for _, report := range operationalReports(result.Reports) {
					if f, ok := report.(*CallFailed); ok {
						failures++
						if f.Call != "s/r1.c1" || f.Script != "s" || f.Operation != (OperationRef{"service", "fetch"}) || f.Detail == "" {
							t.Fatal(f)
						}
					}
				}
				if failures != 1 || strings.Contains(end.Error.Data.String(), "private Host detail") {
					t.Fatal(operationalReports(result.Reports))
				}
				if !strings.Contains(strings.Join(trace, "\n"), "call-failed s/r1.c1 op=api.fetch") {
					t.Fatal(trace)
				}
				errorRecords := 0
				for _, line := range trace {
					if !strings.HasPrefix(line, "call ") && !strings.HasPrefix(line, "> fail ") {
						continue
					}
					parts := strings.SplitN(line, " error=", 2)
					if len(parts) != 2 {
						continue
					}
					errorRecords++
					// Host input Fail and returned call errors must both retain map syntax.
					reader := corevalue.Reader{Text: parts[1]}
					v, err := reader.Value()
					if err != nil || v.Kind != corevalue.Map || reader.At != len(parts[1]) {
						t.Fatal("failure corrupted the Trace error map", line, err)
					}
					if completion != "fail" && test.emptyTrace && parts[1] != "{}" {
						t.Fatal("malformed failure leaked into the call Trace", line)
					}
				}
				if errorRecords != 1 {
					t.Fatal("missing failure Trace record", trace)
				}
			})
		}
	}
}

func TestOperationValidFailureData(t *testing.T) {
	for _, completion := range []string{"immediate", "start", "fail"} {
		for _, test := range []struct {
			name        string
			data        Value
			fuel, alloc int64
		}{
			{"Nothing", Nothing, 19, 16},
			{"empty map", localeMap(t), 19, 16},
			{"map", localeMap(t, KV("payload", mustPublicText("reason"))), 21, 69},
		} {
			t.Run(completion+"/"+test.name, func(t *testing.T) {
				end, result, trace := operationFailureRun(t, completion, &ScriptError{Code: "fetch failed", Data: test.data}, Limits{})
				if end.Outcome != Errored || end.Error == nil || end.Error.Code != "fetch failed" || end.Error.Data.Get("capability").String() != `"api"` || end.Error.Data.Get("operation").String() != `"fetch"` {
					t.Fatal(end)
				}
				if strings.Contains(strings.Join(trace, "\n"), "call-failed ") || len(operationalReports(result.Reports)) != 1 {
					t.Fatal(operationalReports(result.Reports), trace)
				}
				if test.name == "map" && !end.Error.Data.Get("payload").Equal(mustPublicText("reason")) {
					t.Fatal(end.Error)
				}
				// These exact costs are unchanged from the pre-fix public API runs.
				if end.Fuel != test.fuel || end.Alloc != test.alloc {
					t.Fatal(end)
				}
			})
		}
	}
}

func TestOperationFailureConversionLimits(t *testing.T) {
	for _, completion := range []string{"immediate", "start", "fail"} {
		for _, test := range []struct {
			name   string
			limits Limits
		}{
			{"fuel", Limits{FuelPerRun: 16}},
			{"alloc", Limits{AllocPerRun: 68}},
		} {
			t.Run(completion+"/"+test.name, func(t *testing.T) {
				data := localeMap(t, KV("payload", mustPublicText("reason")))
				end, result, trace := operationFailureRun(t, completion, &ScriptError{Code: "fetch failed", Data: data}, test.limits)
				if end.Outcome != LimitFault || end.Limit != test.name || end.Fuel != 14 || end.Alloc != 0 {
					t.Fatal(end)
				}
				if len(operationalReports(result.Reports)) != 1 || strings.Contains(strings.Join(trace, "\n"), "call-failed ") {
					t.Fatal(operationalReports(result.Reports), trace)
				}
			})
		}
	}
}
