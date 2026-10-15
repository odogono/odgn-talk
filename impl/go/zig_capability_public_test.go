package northtalk_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	talk "github.com/odogono/odgn-talk/impl/go"
)

// The same public Host runs on native Go and the embedded backend. The tagged
// parity test compares these observations with a separately built native binary.
// No Message Layer construction or native language execution is used by the Host.
type bridgeTrace struct {
	lines  []string
	record func(string)
}

func (s *bridgeTrace) Record(line string) {
	s.lines = append(s.lines, line)
	if s.record != nil {
		s.record(line)
	}
}

type bridgeObservation struct {
	Name   string
	Trace  []string
	Pumps  []any
	Values []string
	Calls  []string
}

var bridgeNow = time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC)

func bridgeCanonical(v reflect.Value) any {
	if !v.IsValid() {
		return nil
	}
	if v.Type() == reflect.TypeFor[talk.Value]() {
		data, err := talk.EncodeValue(v.Interface().(talk.Value))
		if err != nil {
			panic(err)
		}
		return json.RawMessage(data)
	}
	if v.Type() == reflect.TypeFor[time.Time]() {
		return v.Interface().(time.Time).Format(time.RFC3339Nano)
	}
	if v.Kind() == reflect.Interface || v.Kind() == reflect.Pointer {
		if v.IsNil() {
			return nil
		}
		return bridgeCanonical(v.Elem())
	}
	switch v.Kind() {
	case reflect.Struct:
		out := map[string]any{}
		for i := 0; i < v.NumField(); i++ {
			name := v.Type().Field(i).Name
			// Wording is outside parity, but typed report identity, errors and all
			// accounting fields are compared, including allocation and positions.
			if name != "Detail" && name != "Message" {
				out[name] = bridgeCanonical(v.Field(i))
			}
		}
		return out
	case reflect.Slice:
		out := make([]any, v.Len())
		for i := range out {
			out[i] = bridgeCanonical(v.Index(i))
		}
		return out
	default:
		return v.Interface()
	}
}

func runBridgeCases(t *testing.T) []bridgeObservation {
	t.Helper()
	var observations []bridgeObservation
	cases := []string{"immediate", "synchronous answer", "synchronous fail", "later answer", "later fail", "nil fail", "wrong result", "panic", "Host error", "declared error", "undeclared error", "start panic", "start error", "charge", "charge refusal", "callback inputs", "callback stop", "stop wrong result", "stop Host error", "start stop", "trace stop", "trace wrong result", "cancel cleanup", "revoke", "timeout", "answer then stop", "answer then cancel cleanup", "start cancel", "refusals"}
	for _, name := range cases {
		t.Run(name, func(t *testing.T) {
			observation := bridgeObservation{Name: name}
			var trace bridgeTrace
			core := talk.New()
			var g *talk.Group
			var s *talk.Script
			var pendingCall *talk.Call
			binding := new(int)
			callbackCount := 0
			suspending := strings.Contains(name, "answer") || strings.Contains(name, "fail") && name != "charge refusal" || strings.HasPrefix(name, "start") || name == "cancel cleanup" || name == "revoke" || name == "timeout"
			if name == "Host error" {
				suspending = false
			}
			op := talk.Operation{Name: "read", Args: []talk.Shape{talk.NumberShape}, Result: talk.NumberShape, Cost: talk.Cost{Fuel: 7, Alloc: 3}}
			callback := func(c *talk.Call, args []talk.Value) (talk.Value, error) {
				callbackCount++
				if c.Group() != g || c.ScriptName() != "s" || c.GrantName() != "api" || c.Binding() != binding || c.RunID() != "s/r1" || c.ID() != "s/r1.c1" || c.SegmentID() != "s/r1.s1" || c.ScopeName() != "" || c.Automatic() || !c.Now().Equal(bridgeNow) || len(args) != 1 || !args[0].Equal(talk.Int(4)) {
					t.Fatalf("Call identity/arguments changed: %+v %v", c, args)
				}
				observation.Calls = append(observation.Calls, fmt.Sprintf("%s %s %s", c.ID(), c.RunID(), c.SegmentID()))
				pendingCall = c
				switch name {
				case "panic", "start panic":
					panic("private Host panic")
				case "Host error", "start error", "stop Host error":
					if name == "stop Host error" {
						s.Stop("callback")
					}
					return talk.Nothing, errors.New("private Host error")
				case "declared error", "undeclared error":
					return talk.Nothing, &talk.ScriptError{Code: "offline"}
				case "wrong result", "stop wrong result", "trace wrong result":
					if name == "stop wrong result" {
						s.Stop("callback")
					}
					bad, _ := talk.Text("bad")
					return bad, nil
				case "synchronous answer":
					c.AnswerWithCost(talk.Int(9), 5)
				case "synchronous fail":
					c.Fail(&talk.ScriptError{Code: "offline"})
				case "charge":
					if err := c.Charge(5); err != nil {
						t.Fatal(err)
					}
				case "charge refusal":
					if err := c.Charge(9007199254740991); !errors.Is(err, talk.ErrLimit) {
						t.Fatal(err)
					}
				case "callback stop", "start stop":
					s.Stop("callback")
				case "start cancel":
					s.CancelRun(c.RunID())
				case "callback inputs":
					_, p, err := s.Request(nil, talk.Message{Name: "echo", Args: []talk.Value{talk.Int(3)}})
					if err != nil {
						t.Fatal(err)
					}
					select {
					case <-p.Done():
						t.Fatal("callback input executed inside callback")
					default:
					}
					if _, err := g.Pump(bridgeNow, talk.PumpOptions{}); !isReentrant(err) {
						t.Fatal(err)
					}
					if _, err := g.Load(talk.LoadOptions{Name: "nested", Source: ""}); !isReentrant(err) {
						t.Fatal(err)
					}
				}
				return talk.Int(9), nil
			}
			if suspending {
				op.Mode = talk.Suspending
				op.Start = func(c *talk.Call, args []talk.Value) error { _, err := callback(c, args); return err }
			} else {
				op.Do = callback
			}
			if name == "declared error" {
				op.Errors = []talk.ErrorDecl{{Code: "offline"}}
			}
			if name == "undeclared error" {
				op.Errors = []talk.ErrorDecl{}
			}
			if name == "timeout" {
				op.MaxPending = time.Millisecond
			}
			def, err := core.DefineCapability("service", op, talk.Operation{Name: "clean", Result: talk.NothingShape, Do: func(c *talk.Call, args []talk.Value) (talk.Value, error) {
				if pendingCall == nil {
					t.Fatal("missing pending Call")
				}
				select {
				case <-pendingCall.Context().Done():
				default:
					t.Fatal("abandonment did not precede cleanup callback")
				}
				observation.Calls = append(observation.Calls, "cleanup after cancellation")
				return talk.Nothing, nil
			}})
			if err != nil {
				t.Fatal(err)
			}
			g = core.NewGroup(talk.GroupOptions{Name: "g", Trace: &trace})
			source := "script variable n = 0\non go\n put 8 into n\n ask api to read 4"
			if suspending {
				source += " and wait"
			}
			source += "\n put it into n\n return n\nend go\non echo x\n return x\nend echo\n"
			if strings.Contains(name, "cancel cleanup") || name == "start cancel" {
				source = "on go\n try\n  ask api to read 4 and wait\n finally\n  ask api to clean\n end try\nend go\n"
			}
			s, err = g.Load(talk.LoadOptions{Name: "s", Source: source, Grants: map[string]*talk.Grant{"api": def.GrantAll(binding)}})
			if err != nil {
				t.Fatal(err)
			}
			if name == "trace stop" || name == "trace wrong result" {
				trace.record = func(line string) {
					if strings.HasPrefix(line, "call s/r1.c1 ") {
						s.Stop("trace")
					}
				}
			}
			_, p, err := s.Request(nil, talk.Message{Name: "go"})
			if err != nil {
				t.Fatal(err)
			}
			pump := func(now time.Time) {
				result, err := g.Pump(now, talk.PumpOptions{})
				if err != nil {
					t.Fatal(err)
				}
				observation.Pumps = append(observation.Pumps, bridgeCanonical(reflect.ValueOf(result)))
			}
			pump(bridgeNow)
			if name == "refusals" {
				_, err := g.Pump(bridgeNow.Add(-time.Second), talk.PumpOptions{})
				var host *talk.HostError
				if !errors.As(err, &host) || host.Code != talk.ClockBackwards {
					t.Fatal(err)
				}
				_, err = g.Load(talk.LoadOptions{Name: "s", Source: ""})
				if !errors.As(err, &host) || host.Code != talk.NameReused {
					t.Fatal(err)
				}
				_, err = g.Load(talk.LoadOptions{Name: "bad", Source: "on go\n put into\nend go"})
				var load *talk.LoadError
				if !errors.As(err, &load) {
					t.Fatal(err)
				}
			}
			if callbackCount != 1 {
				t.Fatalf("Operation invoked %d times", callbackCount)
			}
			if suspending && name != "start panic" && name != "start error" && name != "start stop" {
				if name == "later answer" || name == "later fail" || name == "nil fail" {
					done := make(chan struct{})
					go func() {
						defer close(done)
						switch name {
						case "later answer":
							pendingCall.AnswerWithCost(talk.Int(9), 5)
						case "later fail":
							pendingCall.Fail(&talk.ScriptError{Code: "offline"})
						case "nil fail":
							pendingCall.Fail(nil)
						}
					}()
					select {
					case <-done:
					case <-time.After(5 * time.Second):
						t.Fatal("settlement deadlocked")
					}
				}
				switch name {
				case "answer then cancel cleanup":
					pendingCall.Answer(talk.Int(9))
					s.CancelRun(pendingCall.RunID())
				case "cancel cleanup":
					s.CancelRun(pendingCall.RunID())
				case "revoke":
					s.Revoke("api")
					pendingCall.Answer(talk.Int(9))
				case "answer then stop":
					pendingCall.Answer(talk.Int(9))
					s.Stop("after answer")
				}
				next := bridgeNow
				if name == "timeout" {
					next = next.Add(time.Millisecond)
				}
				pump(next)
			}
			if name == "callback inputs" {
				pump(bridgeNow)
			}
			select {
			case <-p.Done():
			default:
				t.Fatal("Request did not settle")
			}
			v, failure := p.Result()
			data, err := talk.EncodeValue(v)
			if err != nil {
				t.Fatal(err)
			}
			observation.Values = append(observation.Values, string(data))
			if failure != nil {
				encoded, err := json.Marshal(bridgeCanonical(reflect.ValueOf(failure)))
				if err != nil {
					t.Fatal(err)
				}
				observation.Values = append(observation.Values, string(encoded))
			}
			if strings.Contains(name, "stop") || strings.Contains(name, "cancel cleanup") || name == "start cancel" || name == "timeout" {
				if suspending {
					select {
					case <-pendingCall.Context().Done():
					default:
						t.Fatal("Call context was not cancelled")
					}
				}
				if suspending {
					pendingCall.Answer(talk.Int(99))
					pump(bridgeNow.Add(time.Millisecond))
				}
			}
			observation.Trace = append([]string{}, trace.lines...)
			observations = append(observations, observation)
		})
	}
	return observations
}
func isReentrant(err error) bool {
	var host *talk.HostError
	return errors.As(err, &host) && host.Code == talk.ReentrantCall
}
func TestCapabilityBridge(t *testing.T) {
	observations := runBridgeCases(t)
	if path := os.Getenv("TALK_BRIDGE_OBSERVATIONS"); path != "" {
		data, err := json.MarshalIndent(observations, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
	}
}
