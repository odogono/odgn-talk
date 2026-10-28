package northtalk_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"strings"
	"sync/atomic"
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
			// A Function Value can't be encoded; its display form identifies it.
			return "display:" + v.Interface().(talk.Value).String()
		}
		return json.RawMessage(data)
	}
	// Handles compare by identity: the kind/id each Core reports.
	if v.Type() == reflect.TypeFor[*talk.Object]() {
		if v.IsNil() {
			return nil
		}
		h := v.Interface().(*talk.Object)
		return h.Value().String()
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
			// The recording predates Partial Restore (ADR 0143), so an empty
			// Reloaded list is what the native Core would have reported.
			if name == "Reloaded" && v.Field(i).Len() == 0 {
				continue
			}
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
	cases := []string{"immediate", "synchronous answer", "synchronous fail", "later answer", "later fail", "nil fail", "wrong result", "panic", "Host error", "declared error", "undeclared error", "start panic", "start error", "charge", "charge refusal", "callback inputs", "callback stop", "stop wrong result", "stop Host error", "start stop", "trace stop", "trace wrong result", "cancel cleanup", "revoke", "timeout", "answer then stop", "answer then cancel cleanup", "start cancel", "refusals", "fire", "fire panic", "fire error", "fire declared error", "fire charge", "fire charge refusal", "fire stop", "fire trace stop", "fire inputs"}
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
			fire := strings.HasPrefix(name, "fire")
			op := talk.Operation{Name: "read", Args: []talk.Shape{talk.NumberShape}, Result: talk.NumberShape, Cost: talk.Cost{Fuel: 7, Alloc: 3}}
			callback := func(c *talk.Call, args []talk.Value) (talk.Value, error) {
				callbackCount++
				if c.Group() != g || c.ScriptName() != "s" || c.GrantName() != "api" || c.Binding() != binding || c.RunID() != "s/r1" || c.ID() != "s/r1.c1" || c.SegmentID() != "s/r1.s1" || c.ScopeName() != "" || c.Automatic() || !c.Now().Equal(bridgeNow) || len(args) != 1 || !args[0].Equal(talk.Int(4)) {
					t.Fatalf("Call identity/arguments changed: %+v %v", c, args)
				}
				observation.Calls = append(observation.Calls, fmt.Sprintf("%s %s %s", c.ID(), c.RunID(), c.SegmentID()))
				pendingCall = c
				switch name {
				case "panic", "start panic", "fire panic":
					panic("private Host panic")
				case "Host error", "start error", "stop Host error", "fire error":
					if name == "stop Host error" {
						s.Stop("callback")
					}
					return talk.Nothing, errors.New("private Host error")
				case "declared error", "undeclared error", "fire declared error":
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
				case "charge", "fire charge":
					if err := c.Charge(5); err != nil {
						t.Fatal(err)
					}
				case "charge refusal", "fire charge refusal":
					if err := c.Charge(9007199254740991); !errors.Is(err, talk.ErrLimit) {
						t.Fatal(err)
					}
				case "callback stop", "start stop", "fire stop":
					s.Stop("callback")
				case "start cancel":
					s.CancelRun(c.RunID())
				case "callback inputs", "fire inputs":
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
			if fire {
				suspending = false
				op.Mode = talk.FireAndForget
				op.Fire = func(c *talk.Call, args []talk.Value) error { _, err := callback(c, args); return err }
			} else if suspending {
				op.Mode = talk.Suspending
				op.Start = func(c *talk.Call, args []talk.Value) error { _, err := callback(c, args); return err }
			} else {
				op.Do = callback
			}
			if name == "declared error" || name == "fire declared error" {
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
			if fire {
				source = "script variable n = 0\non go\n put 8 into n\n tell api to read 4\n return n\nend go\non echo x\n return x\nend echo"
			}
			if strings.Contains(name, "cancel cleanup") || name == "start cancel" {
				source = "on go\n try\n  ask api to read 4 and wait\n finally\n  ask api to clean\n end try\nend go\n"
			}
			s, err = g.Load(talk.LoadOptions{Name: "s", Source: source, Grants: map[string]*talk.Grant{"api": def.GrantAll(binding)}})
			if err != nil {
				t.Fatal(err)
			}
			if name == "trace stop" || name == "trace wrong result" || name == "fire trace stop" {
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
			if name == "callback inputs" || name == "fire inputs" {
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
	observations = append(observations, runReleaseBridgeCases(t)...)
	observations = append(observations, runBroadcastBridgeCases(t)...)
	observations = append(observations, runDecideBridgeCases(t)...)
	observations = append(observations, runObjectBridgeCases(t)...)
	observations = append(observations, runFunctionBridgeCases(t)...)
	observations = append(observations, runLibraryBridgeCases(t)...)
	observations = append(observations, runReloadBridgeCases(t)...)
	observations = append(observations, runExtendVetoBridgeCases(t)...)
	observations = append(observations, runHostCommandBridgeCases(t)...)
	observations = append(observations, runTriageBridgeCases(t)...)
	observations = append(observations, runQueuedCancellationBridgeCases(t)...)
	observations = append(observations, runStopChargeBridgeCases(t)...)
	observations = append(observations, runSendBudgetBridgeCases(t)...)
	observations = append(observations, runErrorDuringBridgeCases(t)...)
	observations = append(observations, runFunctionErrorDuringBridgeCases(t)...)
	observations = append(observations, runSettlementBridgeCases(t)...)
	observations = append(observations, runEffectBridgeCases(t)...)
	observations = append(observations, runStandardBridgeCases(t)...)
	observations = append(observations, runSaveBridgeCases(t)...)
	observations = append(observations, runInputOrderBridgeCases(t)...)
	t.Run("concurrent input order", func(t *testing.T) { observations = append(observations, runConcurrentInputBridgeCase(t)) })
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

func runReleaseBridgeCases(t *testing.T) []bridgeObservation {
	t.Helper()
	var out []bridgeObservation
	for _, name := range []string{"release stop", "release revoke", "release panic", "release inputs", "release cancellation", "release join cancellation", "release settled cancellation", "release settled join cancellation", "release consumed", "release crossing stop", "release trim"} {
		t.Run(name, func(t *testing.T) {
			observation := bridgeObservation{Name: name}
			core := talk.New()
			var trace bridgeTrace
			var g *talk.Group
			var s, target, blocker *talk.Script
			var calls []*talk.Call
			consumed := name == "release consumed"
			suspending := strings.Contains(name, "cancellation") || consumed
			joined := strings.Contains(name, "join")
			settled := strings.Contains(name, "settled") || consumed
			var generated []*talk.Pending
			var releases []talk.GrantContext
			var inRelease, notified atomic.Bool
			op := talk.Operation{Name: "touch", Result: talk.NothingShape, Do: func(c *talk.Call, _ []talk.Value) (talk.Value, error) {
				if name == "release crossing stop" {
					s.Stop("crossing")
				}
				return talk.Nothing, nil
			}}
			if suspending {
				op.Mode = talk.Suspending
				op.Do = nil
				op.Start = func(c *talk.Call, _ []talk.Value) error { calls = append(calls, c); return nil }
			}
			def, err := core.DefineCapability("resource", op, talk.WithReleaseHook(func(ctx talk.GrantContext) {
				if ctx.Group != g || ctx.ScriptName != "s" || ctx.Now != bridgeNow || ctx.Binding != ctx.GrantName {
					t.Fatalf("release context changed: %+v", ctx)
				}
				releases = append(releases, ctx)
				observation.Calls = append(observation.Calls, fmt.Sprintf("release %s %s %s", ctx.ScriptName, ctx.GrantName, ctx.Reason))
				for _, call := range calls {
					cancelled := call.Context().Err() != nil
					if cancelled == consumed {
						t.Fatalf("Call %s cancellation at release: %v", call.ID(), cancelled)
					}
					observation.Calls = append(observation.Calls, fmt.Sprintf("%s cancelled=%v before release", call.ID(), cancelled))
				}
				if name == "release inputs" {
					inRelease.Store(true)
					defer inRelease.Store(false)
					if _, err := g.Pump(bridgeNow, talk.PumpOptions{}); !isReentrant(err) {
						t.Fatal(err)
					}
					if _, err := g.Load(talk.LoadOptions{Name: "nested", Source: ""}); !isReentrant(err) {
						t.Fatal(err)
					}
					done := make(chan error, 1)
					go func() {
						_, p, err := target.Request(nil, talk.Message{Name: "echo", Args: []talk.Value{talk.Int(6)}})
						if err == nil {
							generated = append(generated, p)
						}
						done <- err
					}()
					select {
					case err := <-done:
						if err != nil {
							t.Fatal(err)
						}
					case <-time.After(5 * time.Second):
						t.Fatal("release input deadlocked")
					}
				}
				if name == "release panic" {
					panic("release cannot refuse cleanup")
				}
			}))
			if err != nil {
				t.Fatal(err)
			}
			g = core.NewGroup(talk.GroupOptions{Name: "g", Trace: &trace, OnReady: func() {
				if inRelease.Load() && notified.CompareAndSwap(false, true) {
					if _, err := g.Pump(bridgeNow, talk.PumpOptions{}); !isReentrant(err) {
						t.Fatal(err)
					}
					_, p, err := target.Request(nil, talk.Message{Name: "echo", Args: []talk.Value{talk.Int(6)}})
					if err != nil {
						t.Fatal(err)
					}
					generated = append(generated, p)
				}
			}})
			if settled && !consumed {
				blocker, err = g.Load(talk.LoadOptions{Name: "blocker", Source: "on busy\n return 1\nend busy"})
				if err != nil {
					t.Fatal(err)
				}
			}
			wait := ""
			if suspending {
				wait = " and wait"
			}
			source := "on go\n ask api to touch" + wait + "\nend go"
			if joined {
				source = "on go\n wait for all\n  ask api to touch and wait\n  ask api to touch and wait\n end wait\nend go"
			}
			s, err = g.Load(talk.LoadOptions{Name: "s", Source: source, Grants: map[string]*talk.Grant{"api": def.GrantAll("api"), "z": def.GrantAll("z")}, GrantsAsUsed: name == "release trim"})
			if err != nil {
				t.Fatal(err)
			}
			if name == "release inputs" {
				target, err = g.Load(talk.LoadOptions{Name: "target", Source: "on echo x\n return x\nend echo"})
				if err != nil {
					t.Fatal(err)
				}
			}
			pump := func() {
				result, err := g.Pump(bridgeNow, talk.PumpOptions{})
				if err != nil {
					t.Fatal(err)
				}
				observation.Pumps = append(observation.Pumps, bridgeCanonical(reflect.ValueOf(result)))
			}
			switch {
			case suspending || name == "release crossing stop":
				if _, err = s.Deliver(talk.Message{Name: "go"}); err != nil {
					t.Fatal(err)
				}
				pump()
			case name == "release revoke":
				s.Revoke("api")
				pump()
				s.Revoke("api")
				s.Revoke("missing")
				pump()
			}
			if suspending {
				want := 1
				if joined {
					want = 2
				}
				if len(calls) != want {
					t.Fatalf("got %d Calls, want %d", len(calls), want)
				}
			}
			if settled {
				calls[0].Answer(talk.Nothing)
				if blocker != nil {
					if _, err := blocker.Deliver(talk.Message{Name: "busy"}); err != nil {
						t.Fatal(err)
					}
				}
				opts := talk.PumpOptions{FuelCap: 1}
				if consumed {
					opts.FuelCap = 0
				}
				result, err := g.Pump(bridgeNow, opts)
				if err != nil {
					t.Fatal(err)
				}
				observation.Pumps = append(observation.Pumps, bridgeCanonical(reflect.ValueOf(result)))
				if calls[0].Context().Err() != nil {
					t.Fatal("settlement cancelled the Call")
				}
			}
			if name != "release crossing stop" {
				s.Stop("done")
				pump()
			}
			for _, p := range generated {
				select {
				case <-p.Done():
					t.Fatal("release input ran before next Pump")
				default:
				}
			}
			if len(generated) > 0 {
				pump()
				for _, p := range generated {
					v, e := p.Result()
					if e != nil || !v.Equal(talk.Int(6)) {
						t.Fatal(v, e)
					}
					observation.Values = append(observation.Values, v.String())
				}
			}
			if name == "release inputs" && !notified.Load() {
				t.Fatal("release input did not notify OnReady")
			}
			before := len(releases)
			s.Stop("again")
			pump()
			if len(releases) != before {
				t.Fatal("repeated Stop repeated release")
			}
			want := 2
			if name == "release revoke" {
				want = 3
			}
			if name == "release trim" {
				want = 1
			}
			if len(releases) != want {
				t.Fatalf("got %d releases, want %d", len(releases), want)
			}
			observation.Trace = append([]string{}, trace.lines...)
			out = append(out, observation)
		})
	}
	return out
}
