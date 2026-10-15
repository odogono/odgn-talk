package zigprobe

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	talk "github.com/odogono/odgn-talk/impl/go"
)

var parityNow = time.Date(2026, 10, 14, 12, 0, 0, 0, time.UTC)

// These are experimental Host adapters, not a public-compatible binding.
// Callbacks execute in Go after Frame releases its export lock. Every result
// owns its bytes before another export, and the initiating ref stays reserved.
func callbackResult(callback func() (talk.Value, error), key string) (result obj) {
	defer func() {
		if caught := recover(); caught != nil {
			result = obj{"hostError": fmt.Sprintf("Host panic: %v", caught)}
		}
	}()
	v, err := callback()
	if err != nil {
		var failure *talk.ScriptError
		if errors.As(err, &failure) {
			shown := obj{"code": failure.Code, "data": encoded(failure.Data)}
			if failure.Message != "" {
				shown["message"] = failure.Message
			}
			return obj{"fail": shown}
		}
		return obj{"hostError": err.Error()}
	}
	return obj{key: encoded(v)}
}

func encoded(v talk.Value) json.RawMessage {
	b, err := talk.EncodeValue(v)
	if err != nil {
		panic(err)
	}
	return b
}

// An explicit ref does not move the next-input counter backwards after an
// input was admitted inside a paused callback.
func (h *host) at(ref int, m string, fields obj) obj {
	h.t.Helper()
	frame := obj{"m": m, "ref": ref}
	for k, v := range fields {
		frame[k] = v
	}
	b, err := json.Marshal(frame)
	if err != nil {
		h.t.Fatal(err)
	}
	b, err = h.r.Frame(context.Background(), b)
	if err != nil {
		h.t.Fatal(err)
	}
	var reply obj
	if err := json.Unmarshal(b, &reply); err != nil {
		h.t.Fatal(err)
	}
	if reply["ref"] != float64(ref) {
		h.t.Fatalf("wrong ref: %s", b)
	}
	return reply
}

func collectTrace(reply obj) []string {
	var lines []string
	if ok, present := reply["ok"].(map[string]any); present {
		for _, line := range slice(ok["trace"]) {
			lines = append(lines, line.(string))
		}
	}
	return lines
}

func slice(v any) []any {
	if v == nil {
		return nil
	}
	return v.([]any)
}

func assertTrace(t *testing.T, native traceLines, replies ...obj) {
	t.Helper()
	var got []string
	for _, reply := range replies {
		got = append(got, collectTrace(reply)...)
	}
	if strings.Join(native, "\n") != strings.Join(got, "\n") {
		t.Fatalf("Trace differs\nnative:\n%s\nZig:\n%s", strings.Join(native, "\n"), strings.Join(got, "\n"))
	}
}

func nativePump(t *testing.T, g *talk.Group) talk.PumpResult {
	t.Helper()
	r, err := g.Pump(parityNow, talk.PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func nativeLoad(t *testing.T, g *talk.Group, source string, grants map[string]*talk.Grant) *talk.Script {
	t.Helper()
	s, err := g.Load(talk.LoadOptions{Name: "s", Source: source, Grants: grants})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func nativeRequest(t *testing.T, s *talk.Script, args ...talk.Value) *talk.Pending {
	t.Helper()
	_, p, err := s.Request(nil, talk.Message{Name: "go", Args: args})
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func assertPump(t *testing.T, native talk.PumpResult, reply obj) {
	t.Helper()
	ok := field(t, reply, "ok")
	states := map[talk.GroupState]string{talk.Idle: "idle", talk.Sliced: "sliced", talk.Stopped: "stopped", talk.Rewound: "rewound"}
	if ok["state"] != states[native.State] || ok["fuelUsed"] != float64(native.FuelUsed) {
		t.Fatalf("Pump differs: native=%+v Zig=%v", native, ok)
	}
	// Report identities/order and accounting are independent observations of the
	// public API. Host-only detail and non-normative error wording are excluded.
	var want []obj
	for _, r := range native.Reports {
		switch r := r.(type) {
		case *talk.RunEnd:
			outcomes := map[talk.Outcome]string{talk.Completed: "completed", talk.Errored: "errored", talk.Cancelled: "cancelled", talk.LimitFault: "limit fault", talk.EffectFailureOutcome: "effect failed"}
			x := obj{"kind": "run end", "script": r.Script, "run": string(r.Run), "outcome": outcomes[r.Outcome], "fuel": r.Fuel, "alloc": r.Alloc}
			if r.Outcome == talk.Completed {
				x["result"] = encoded(r.Result)
			}
			if r.Error != nil {
				x["code"] = r.Error.Code
			}
			if r.CleanupFailed != nil {
				x["cleanup"] = r.CleanupFailed.Code + r.CleanupFailed.Limit
			}
			want = append(want, x)
		case *talk.CallFailed:
			want = append(want, obj{"kind": "call failed", "script": r.Script, "call": string(r.Call)})
		case *talk.Stop:
			want = append(want, obj{"kind": "stop", "script": r.Script, "reason": r.Reason, "discardedRuns": append([]talk.RunID{}, r.DiscardedRuns...), "pendingCalls": append([]talk.CallID{}, r.PendingCalls...)})
		case *talk.EffectFailure:
			want = append(want, obj{"kind": "effect failure", "phase": r.Phase, "status": string(r.Status)})
		case *talk.RunAccounting:
			want = append(want, obj{"kind": "run accounting", "run": string(r.Run), "fuel": r.Fuel, "state": r.State})
		case *talk.RunStarted:
			want = append(want, obj{"kind": "run started", "run": string(r.Run)})
		case *talk.RunDiscarded:
			want = append(want, obj{"kind": "run discarded", "run": string(r.Run), "reason": r.Reason})
		case *talk.CausalWork:
			want = append(want, obj{"kind": "causal work", "rootDelivery": string(r.RootDelivery), "liveRuns": r.LiveRuns, "queuedMessages": r.QueuedMessages, "discardedMessages": r.DiscardedMessages})
		default:
			t.Fatalf("uncompared public Report %T", r)
		}
	}
	var got []obj
	for i, r := range slice(ok["reports"]) {
		if i >= len(want) {
			t.Fatalf("extra Zig Report: %v", r)
		}
		x := r.(map[string]any)
		if x["kind"] != want[i]["kind"] {
			t.Fatalf("Report order differs at %d: want=%v Zig=%v", i, want, ok["reports"])
		}
		selected := obj{}
		for key := range want[i] {
			switch key {
			case "code":
				selected[key] = field(t, x, "error")["code"]
			case "cleanup":
				c := field(t, x, "cleanupFailed")
				selected[key] = fmt.Sprint(c["code"])
				if c["limit"] != nil {
					selected[key] = c["limit"]
				}
			case "run":
				selected[key] = x[key]
				if selected[key] == nil {
					selected[key] = ""
				}
			default:
				selected[key] = x[key]
			}
		}
		got = append(got, selected)
	}
	// Marshal normalizes native named types and JSON-decoded integer types.
	a, _ := json.Marshal(want)
	b, _ := json.Marshal(got)
	if string(a) != string(b) {
		t.Fatalf("Reports differ\nnative: %s\nZig:    %s", a, b)
	}
}

func TestCallbackPanicParity(t *testing.T) {
	for _, mode := range []string{"immediate", "suspending", "fire-and-forget"} {
		t.Run(mode, func(t *testing.T) {
			callback := func() (talk.Value, error) { panic("private Host detail") }
			op := talk.Operation{Name: "read", Mode: talk.Immediate, Result: talk.NumberShape, Do: func(*talk.Call, []talk.Value) (talk.Value, error) { return callback() }}
			suffix := ""
			if mode == "suspending" {
				op.Mode = talk.Suspending
				op.Do = nil
				op.Start = func(*talk.Call, []talk.Value) error { _, err := callback(); return err }
				op.MaxPending = 5 * time.Second
				suffix = " and wait"
			}
			if mode == "fire-and-forget" {
				op.Mode = talk.FireAndForget
				op.Do = nil
				op.Result = talk.Shape{}
				op.Fire = func(*talk.Call, []talk.Value) error { _, err := callback(); return err }
			}
			core := talk.New()
			def, err := core.DefineCapability("api", op)
			if err != nil {
				t.Fatal(err)
			}
			verb := "ask"
			if mode == "fire-and-forget" {
				verb = "tell"
			}
			source := "on go\n try\n  " + verb + " api to read" + suffix + "\n catch e\n  return the code of e\n end try\nend go"
			var trace traceLines
			g := core.NewGroup(talk.GroupOptions{Trace: &trace})
			script := nativeLoad(t, g, source, map[string]*talk.Grant{"api": def.GrantAll(nil)})
			trace = nil
			nativeRequest(t, script)
			native := nativePump(t, g)
			h := newHost(t)
			h.setupTrace(mode, source, true)
			requested := h.frame("request", obj{"group": "g", "to": obj{"script": "s"}, "message": obj{"name": "go"}}, true)
			paused := h.pump("g")
			done := h.result("op-result", callbackResult(callback, "result"))
			if end(t, done)["result"] != "host error" {
				t.Fatal(done)
			}
			assertPump(t, native, done)
			assertTrace(t, trace, requested, paused, done)
		})
	}
}

func TestWorkerReentryParity(t *testing.T) {
	core := talk.New()
	var g *talk.Group
	var s *talk.Script
	library, err := core.CompileLibrary(talk.LibrarySource{Name: "util", Source: "function one\n return 1\nend one"}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	check := func(err error) {
		t.Helper()
		var hostError *talk.HostError
		if !errors.As(err, &hostError) || hostError.Code != talk.ReentrantCall {
			t.Fatalf("worker reentry: %v", err)
		}
	}
	def, err := core.DefineCapability("api", talk.Operation{Name: "read", Mode: talk.Immediate, Result: talk.NumberShape,
		Do: func(*talk.Call, []talk.Value) (talk.Value, error) {
			_, err := g.Pump(parityNow, talk.PumpOptions{})
			check(err)
			_, err = g.Save()
			check(err)
			_, err = g.Load(talk.LoadOptions{Name: "nested", Source: ""})
			check(err)
			func() {
				defer func() {
					if caught := recover(); caught != nil {
						check(caught.(error))
					} else {
						t.Fatal("Inspect allowed callback reentry")
					}
				}()
				g.Inspect()
			}()
			func() {
				defer func() {
					caught := recover()
					if caught == nil {
						t.Fatal("Counters allowed callback reentry")
					}
					check(caught.(error))
				}()
				s.Counters()
			}()
			_, err = s.Reload("", talk.ResetVariables)
			check(err)
			check(s.Extend(""))
			check(g.AddLibrary(library))
			_, err = g.ReplaceLibrary(library, talk.ResetVariables)
			check(err)
			return talk.Int(42), nil
		}})
	if err != nil {
		t.Fatal(err)
	}
	var trace traceLines
	g = core.NewGroup(talk.GroupOptions{Trace: &trace})
	const source = "on go\n ask api to read\n return it\nend go"
	s = nativeLoad(t, g, source, map[string]*talk.Grant{"api": def.GrantAll(nil)})
	trace = nil
	nativeRequest(t, s)
	native := nativePump(t, g)
	h := newHost(t)
	h.ok("new-group", obj{"group": "other", "name": "other"})
	identity := h.ok("compile-library", obj{"name": "util", "source": "function one\n return 1\nend one"})["identity"]
	h.setupTrace("immediate", source, true)
	requested := h.frame("request", obj{"group": "g", "to": obj{"script": "s"}, "message": obj{"name": "go"}}, true)
	paused := h.pump("g")
	worker := h.ref
	for _, m := range []string{"pump", "save", "load", "inspect", "counters", "reload", "extend", "add-library", "replace-library"} {
		r := h.frame(m, obj{"group": "g", "name": "nested", "source": "", "now": parityNow.Format(time.RFC3339Nano), "script": "s", "carry": "reset variables", "identity": identity}, true)
		if field(t, r, "err")["code"] != "reentrant call" {
			t.Fatal(m, r)
		}
	}
	for _, r := range []obj{
		h.at(worker, "prop-result", obj{"value": 42}),
		h.at(worker+100, "op-result", obj{"result": 42}),
		h.frame("stop", obj{"group": "other", "script": "missing", "reason": "wrong Group"}, true),
	} {
		if field(t, r, "err")["kind"] != "protocol error" {
			t.Fatal(r)
		}
	}
	malformed, err := h.r.Frame(context.Background(), []byte(`{"m":"op-result","ref":`))
	if err != nil || !strings.Contains(string(malformed), `"protocol error"`) {
		t.Fatal(string(malformed), err)
	}
	independent := newHost(t)
	if independent.ok("add", obj{"a": 20, "b": 22})["value"] != float64(42) {
		t.Fatal("second Session blocked")
	}
	done := h.at(worker, "op-result", obj{"result": 42})
	assertPump(t, native, done)
	assertTrace(t, trace, requested, paused, done)
	if end(t, done)["result"] != float64(42) {
		t.Fatal(done)
	}
}

func TestPropertyCallbackParity(t *testing.T) {
	for _, set := range []bool{false, true} {
		for _, outcome := range []string{"value", "wrong shape", "panic"} {
			if set && outcome == "wrong shape" {
				continue // Set has no return Value to convert.
			}
			for _, stop := range []bool{false, true} {
				t.Run(fmt.Sprintf("set=%t/%s/stop=%t", set, outcome, stop), func(t *testing.T) {
					core := talk.New()
					var script *talk.Script
					invocations := 0
					callback := func() (talk.Value, error) {
						invocations++
						if stop {
							script.Stop("property")
						}
						if outcome == "panic" {
							panic("private property detail")
						}
						if outcome == "wrong shape" {
							return talk.Text("wrong")
						}
						return talk.Int(7), nil
					}
					prop := talk.Prop{Name: "value", Shape: talk.NumberShape, Get: func(*talk.Object) (talk.Value, error) { return callback() }}
					if set {
						prop.Set = func(_ *talk.Object, v talk.Value) error {
							if !v.Equal(talk.Int(7)) {
								t.Fatal(v)
							}
							_, err := callback()
							return err
						}
					}
					kind, err := core.DefineObjectKind(talk.ObjectKindDef{Name: "box", Props: []talk.Prop{prop}})
					if err != nil {
						t.Fatal(err)
					}
					var trace traceLines
					g := core.NewGroup(talk.GroupOptions{Trace: &trace})
					o, err := g.Object(kind, "one", nil)
					if err != nil {
						t.Fatal(err)
					}
					statement := "put the value of box into n"
					if set {
						statement = "set the value of box to 7"
					}
					source := "script variable n=0\non go\n put 9 into n\n " + statement + "\n put 8 into n\n return n\nend go"
					script, err = g.Load(talk.LoadOptions{Name: "s", Source: source, Objects: map[string]*talk.Object{"box": o}})
					if err != nil {
						t.Fatal(err)
					}
					trace = nil
					nativeRequest(t, script)
					native := nativePump(t, g)
					if invocations != 1 {
						t.Fatal("native callback repeated", invocations)
					}
					h := newHost(t)
					h.ok("define-object-kind", obj{"name": "box", "props": []obj{{"name": "value", "shape": "number", "readOnly": !set}}})
					h.ok("new-group", obj{"group": "g", "name": "g", "trace": true})
					h.ok("object", obj{"group": "g", "kind": "box", "id": "one"})
					h.ok("load", obj{"group": "g", "name": "s", "source": source, "objects": obj{"box": obj{"$object": []string{"box", "one"}}}})
					requested := h.frame("request", obj{"group": "g", "to": obj{"script": "s"}, "message": obj{"name": "go"}}, true)
					paused := h.pump("g")
					worker := h.ref
					need := field(t, paused, "need")
					_, writes := need["value"]
					if need["m"] != "prop" || need["prop"] != "value" || writes != set {
						t.Fatal(need)
					}
					var admitted obj
					if stop {
						admitted = h.frame("stop", obj{"group": "g", "script": "s", "reason": "property"}, true)
					}
					// Execute the same Host function with transport controls. No
					// native Group is touched from the embedded callback.
					transportCallback := func() (talk.Value, error) {
						if outcome == "panic" {
							panic("private property detail")
						}
						if outcome == "wrong shape" {
							return talk.Text("wrong")
						}
						return talk.Int(7), nil
					}
					done := h.at(worker, "prop-result", callbackResult(transportCallback, "value"))
					assertPump(t, native, done)
					assertTrace(t, trace, requested, paused, admitted, done)
					want := "9"
					if stop {
						want = "0"
					}
					if outcome == "value" && !stop {
						want = "8"
					}
					if got := g.Inspect().Scripts[0].Vars[0].Val.String(); got != want {
						t.Fatalf("native n=%s want %s", got, want)
					}
					if got := h.ok("inspect", obj{"group": "g"})["scripts"].([]any)[0].(map[string]any)["vars"].([]any)[0].([]any)[1]; fmt.Sprint(got) != want {
						t.Fatalf("Zig n=%v want %s", got, want)
					}
				})
			}
		}
	}
}

func TestSuspendingCancellationContextParity(t *testing.T) {
	for _, control := range []string{"cancel-run", "stop", "timeout", "request-context"} {
		t.Run(control, func(t *testing.T) {
			core := talk.New()
			var call *talk.Call
			def, err := core.DefineCapability("api", talk.Operation{Name: "read", Mode: talk.Suspending, Result: talk.NumberShape, MaxPending: 5 * time.Second,
				Start: func(c *talk.Call, _ []talk.Value) error { call = c; return nil }})
			if err != nil {
				t.Fatal(err)
			}
			var trace traceLines
			ready := make(chan struct{}, 8)
			g := core.NewGroup(talk.GroupOptions{Trace: &trace, OnReady: func() { ready <- struct{}{} }})
			const source = "script variable n=0\non go\n put 9 into n\n ask api to read and wait\n put 8 into n\n return n\nend go"
			s := nativeLoad(t, g, source, map[string]*talk.Grant{"api": def.GrantAll(nil)})
			trace = nil
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			id, pending, err := s.Request(ctx, talk.Message{Name: "go"})
			if err != nil {
				t.Fatal(err)
			}
			first := nativePump(t, g)
			if call.Context().Err() != nil {
				t.Fatal("Call context cancelled at Start")
			}
			h := newHost(t)
			h.setupTrace("suspending", source, true)
			requested := h.frame("request", obj{"group": "g", "to": obj{"script": "s"}, "message": obj{"name": "go"}}, true)
			paused := h.pump("g")
			callID := field(t, paused, "need")["call"].(string)
			parked := h.result("op-result", obj{"started": true})
			assertPump(t, first, parked)
			assertTrace(t, trace, requested, paused, parked)
			trace = nil
			workCtx, abandon := context.WithCancel(context.Background())
			defer abandon()
			if workCtx.Err() != nil {
				t.Fatal("Host work cancelled at Start")
			}
			now := parityNow
			var admitted obj
			switch control {
			case "cancel-run":
				s.CancelRun(call.RunID())
				admitted = h.frame("cancel-run", obj{"group": "g", "script": "s", "run": callID[:strings.LastIndex(callID, ".c")]}, true)
			case "stop":
				s.Stop("cancelled work")
				admitted = h.frame("stop", obj{"group": "g", "script": "s", "reason": "cancelled work"}, true)
			case "timeout":
				now = now.Add(5 * time.Second)
			case "request-context":
				for len(ready) > 0 {
					<-ready
				}
				cancel()
				select {
				case <-ready:
				case <-time.After(time.Second):
					t.Fatal("context cancellation was not queued")
				}
				admitted = h.frame("cancel-delivery", obj{"group": "g", "delivery": string(id)}, true)
			}
			second, err := g.Pump(now, talk.PumpOptions{})
			if err != nil {
				t.Fatal(err)
			}
			done := h.frame("pump", obj{"group": "g", "now": now.Format(time.RFC3339Nano)}, true)
			abandoned := field(t, done, "ok")["abandoned"].([]any)
			if len(abandoned) != 1 || abandoned[0] != callID {
				t.Fatal("abandonment missing or repeated", abandoned)
			}
			abandon() // the Host maps the reactor's notification to its work context
			if !errors.Is(call.Context().Err(), context.Canceled) || !errors.Is(workCtx.Err(), context.Canceled) {
				t.Fatal("work contexts not cancelled")
			}
			select {
			case <-pending.Done():
			default:
				t.Fatal("native Request unsettled")
			}
			assertPump(t, second, done)
			assertTrace(t, trace, admitted, done)
			trace = nil
			call.Answer(talk.Int(42))
			late := h.frame("answer", obj{"group": "g", "call": callID, "value": 42}, true)
			third, err := g.Pump(now, talk.PumpOptions{})
			if err != nil {
				t.Fatal(err)
			}
			healthy := h.frame("pump", obj{"group": "g", "now": now.Format(time.RFC3339Nano)}, true)
			if len(field(t, healthy, "ok")["abandoned"].([]any)) != 0 {
				t.Fatal("duplicate abandonment")
			}
			assertPump(t, third, healthy)
			assertTrace(t, trace, late, healthy)
		})
	}
}

func TestPendingCallRestoreParity(t *testing.T) {
	for _, how := range []string{"answer", "fail", "adopt", "reissue", "reissue-stop"} {
		t.Run(how, func(t *testing.T) {
			core := talk.New()
			starts := 0
			var active *talk.Call
			def, err := core.DefineCapability("api", talk.Operation{Name: "read", Mode: talk.Suspending, Result: talk.NumberShape, MaxPending: 5 * time.Second,
				Start: func(c *talk.Call, _ []talk.Value) error {
					starts++
					active = c
					if starts > 2 && how == "reissue-stop" {
						c.Group().Script("s").Stop("reissued")
					}
					return nil
				}})
			if err != nil {
				t.Fatal(err)
			}
			grant := def.GrantAll("restored binding")
			var trace traceLines
			g := core.NewGroup(talk.GroupOptions{Name: "g", Trace: &trace})
			source := "on go\n ask api to read and wait\n return it\nend go"
			pendingCount := 1
			if how == "reissue-stop" {
				source = "on go\n wait for all\n  ask api to read and wait\n  ask api to read and wait\n end wait\n return 42\nend go"
				pendingCount = 2
			}
			s := nativeLoad(t, g, source, map[string]*talk.Grant{"api": grant})
			nativeRequest(t, s)
			nativePump(t, g)
			saved, err := g.Save()
			if err != nil {
				t.Fatal(err)
			}
			restored, info, err := core.Restore(saved, talk.RestoreOptions{Name: "g", Trace: &trace, Grants: func(script, name string) *talk.Grant {
				if script != "s" || name != "api" {
					t.Fatalf("unexpected Grant resolution: %s %s", script, name)
				}
				return grant
			}})
			if err != nil || len(info.Pending) != pendingCount {
				t.Fatal(info, err)
			}
			trace = nil
			h := newHost(t)
			h.setupTrace("suspending", source, true)
			h.request("g")
			need := field(t, h.pump("g"), "need")
			initial := h.result("op-result", obj{"started": true})
			if pendingCount == 2 {
				field(t, initial, "need")
				initial = h.result("op-result", obj{"started": true})
			}
			field(t, initial, "ok")
			snapshot := h.ok("save", obj{"group": "g"})["save"]
			grantHandle := h.ok("grant", obj{"capability": "api", "ops": "all"})["grant"]
			asked := h.frame("restore", obj{"group": "restored", "name": "g", "trace": true, "save": snapshot}, true)
			resolve := field(t, asked, "need")
			if resolve["m"] != "resolve" {
				t.Fatal(resolve)
			}
			// The original and restored Grants have the same declaration;
			// this test Host reuses the explicit registered Grant handle.
			ready := field(t, h.result("resolve-result", obj{"grants": []any{grantHandle}, "objects": []any{}}), "ok")
			pending := ready["pending"].([]any)
			if len(pending) != pendingCount {
				t.Fatal(ready)
			}
			callID := pending[0].(map[string]any)["call"].(string)
			if callID != string(info.Pending[0].ID) || callID != need["call"] {
				t.Fatal("restored Call identity changed", callID, info.Pending)
			}
			answer := talk.Int(42)
			settlement := talk.Settlement{}
			wire := obj{}
			switch how {
			case "answer":
				settlement.Answer = &answer
				wire["answer"] = 42
			case "fail":
				settlement.Fail = &talk.ScriptError{Code: "gone"}
				wire["fail"] = obj{"code": "gone"}
			case "adopt":
				settlement.Adopt = true
				wire["adopt"] = true
			case "reissue", "reissue-stop":
				settlement.Reissue = true
				wire["reissue"] = true
			}
			adopted, err := restored.Settle(info.Pending[0].ID, settlement)
			if err != nil {
				t.Fatal(err)
			}
			settled := h.frame("settle", obj{"group": "restored", "call": callID, "settlement": wire}, true)
			field(t, settled, "ok")
			replies := []obj{settled}
			if pendingCount == 2 {
				if _, err = restored.Settle(info.Pending[1].ID, talk.Settlement{Reissue: true}); err != nil {
					t.Fatal(err)
				}
				replies = append(replies, h.frame("settle", obj{"group": "restored", "call": pending[1].(map[string]any)["call"], "settlement": obj{"reissue": true}}, true))
			}
			if how == "adopt" {
				if adopted == nil || adopted.Context().Err() != nil {
					t.Fatal("adopted Call context unavailable")
				}
				adopted.Answer(answer)
				replies = append(replies, h.frame("answer", obj{"group": "restored", "call": callID, "value": 42}, true))
			}
			native := nativePump(t, restored)
			done := h.pump("restored")
			replies = append(replies, done)
			if how == "reissue" || how == "reissue-stop" {
				if starts != pendingCount+1 || (how == "reissue" && active.Context().Err() != nil) || field(t, done, "need")["call"] != callID {
					t.Fatal("reissue identity/Start mismatch", starts, done)
				}
				worker := int(done["ref"].(float64))
				if how == "reissue-stop" {
					replies = append(replies, h.frame("stop", obj{"group": "restored", "script": "s", "reason": "reissued"}, true))
				}
				done = h.at(worker, "op-result", obj{"started": true})
				replies = append(replies, done)
				assertPump(t, native, done)
				assertTrace(t, trace, replies...)
				if how == "reissue-stop" {
					if !errors.Is(active.Context().Err(), context.Canceled) {
						t.Fatal("reissued Call context not cancelled")
					}
					return
				}
				trace = nil
				active.Answer(answer)
				answered := h.frame("answer", obj{"group": "restored", "call": callID, "value": 42}, true)
				native = nativePump(t, restored)
				done = h.pump("restored")
				replies = []obj{answered, done}
			}
			assertPump(t, native, done)
			assertTrace(t, trace, replies...)
			row := end(t, done)
			if how == "fail" {
				if field(t, row, "error")["code"] != "gone" {
					t.Fatal(row)
				}
			} else if row["result"] != float64(42) {
				t.Fatal(row)
			}
		})
	}
}

// Both Hosts stage effects until Commit and acknowledge release before allowing
// the worker to continue. This exercises real Go lifecycle/scope callbacks.
func TestEffectRollbackReleaseParity(t *testing.T) {
	for _, stop := range []bool{false, true} {
		t.Run(fmt.Sprint("stop=", stop), func(t *testing.T) {
			core := talk.New()
			var nativeEvents, wireEvents []string
			staged, published, wireStaged, wirePublished := 0, 0, 0, 0
			hook := func(phase string) func(talk.SegmentContext) talk.EffectResult {
				return func(talk.SegmentContext) talk.EffectResult {
					nativeEvents = append(nativeEvents, phase)
					if phase == "commit" {
						published += staged
						staged = 0
					}
					if phase == "rollback" {
						staged = 0
					}
					return talk.EffectResult{Status: talk.EffectOK}
				}
			}
			def, err := core.DefineSegmentCapability("resource", talk.SegmentLifecycle{Begin: hook("begin"), Commit: hook("commit"), Rollback: hook("rollback")},
				talk.Operation{Name: "open", Mode: talk.Immediate, SegmentBound: true, Result: talk.NothingShape, Scope: &talk.ScopeDecl{Opens: "file", Abandon: "close"}, Do: func(c *talk.Call, _ []talk.Value) (talk.Value, error) {
					nativeEvents = append(nativeEvents, "open")
					staged++
					if stop {
						c.Group().Script(c.ScriptName()).Stop("done")
					}
					return talk.Nothing, nil
				}},
				talk.Operation{Name: "close", Mode: talk.Immediate, SegmentBound: true, Result: talk.NothingShape, Scope: &talk.ScopeDecl{Closes: "file"}, Do: func(c *talk.Call, _ []talk.Value) (talk.Value, error) {
					if !c.Automatic() {
						t.Fatal("expected automatic scope abandonment")
					}
					nativeEvents = append(nativeEvents, "close")
					return talk.Nothing, nil
				}}, talk.WithReleaseHook(func(c talk.GrantContext) { nativeEvents = append(nativeEvents, "release:"+string(c.Reason)) }))
			if err != nil {
				t.Fatal(err)
			}
			var trace traceLines
			g := core.NewGroup(talk.GroupOptions{Name: "g", Trace: &trace})
			const source = "script variable n=0\non go\n put 9 into n\n ask api to open\n put 8 into n\n return n\nend go"
			s := nativeLoad(t, g, source, map[string]*talk.Grant{"api": def.GrantAll("binding")})
			trace = nil
			nativeRequest(t, s)
			native := nativePump(t, g)
			h := newHost(t)
			h.ok("define-capability", obj{"name": "resource", "segmentLifecycle": true, "release": true, "ops": []any{
				obj{"name": "open", "mode": "immediate", "result": "nothing", "segmentBound": true, "scope": obj{"opens": "file", "abandon": "close"}},
				obj{"name": "close", "mode": "immediate", "result": "nothing", "segmentBound": true, "scope": obj{"closes": "file"}},
			}})
			grant := h.ok("grant", obj{"capability": "resource", "ops": "all"})["grant"]
			h.ok("new-group", obj{"group": "g", "name": "g", "trace": true})
			h.ok("load", obj{"group": "g", "name": "s", "grants": obj{"api": grant}, "source": source})
			replies := []obj{h.frame("request", obj{"group": "g", "to": obj{"script": "s"}, "message": obj{"name": "go"}}, true)}
			done := h.pump("g")
			worker := int(done["ref"].(float64))
			for turns := 0; ; turns++ {
				if turns > 8 {
					t.Fatal("callback loop", done)
				}
				replies = append(replies, done)
				need, paused := done["need"].(map[string]any)
				if !paused {
					break
				}
				switch need["m"] {
				case "effect":
					phase := need["phase"].(string)
					wireEvents = append(wireEvents, phase)
					if phase == "commit" {
						wirePublished += wireStaged
						wireStaged = 0
					}
					if phase == "rollback" {
						wireStaged = 0
					}
					done = h.at(worker, "effect-result", obj{"status": "ok"})
				case "op":
					op := need["operation"].(string)
					wireEvents = append(wireEvents, op)
					if op == "open" {
						wireStaged++
						if stop {
							replies = append(replies, h.frame("stop", obj{"group": "g", "script": "s", "reason": "done"}, true))
						}
					} else if op != "close" || need["automatic"] != true {
						t.Fatal("unexpected scope callback", need)
					}
					done = h.at(worker, "op-result", obj{"result": nil})
				case "release":
					wireEvents = append(wireEvents, "release:"+need["reason"].(string))
					done = h.at(worker, "release-result", nil)
				default:
					t.Fatal("unexpected callback", need)
				}
			}
			if fmt.Sprint(nativeEvents) != fmt.Sprint(wireEvents) || staged != wireStaged || published != wirePublished {
				t.Fatal(nativeEvents, wireEvents, staged, wireStaged, published, wirePublished)
			}
			want := 1
			if stop {
				want = 0
			}
			if staged != 0 || published != want {
				t.Fatal("effect publication differs", staged, published)
			}
			assertPump(t, native, done)
			assertTrace(t, trace, replies...)
			if stop {
				trace = nil
				again := h.pump("g")
				assertPump(t, nativePump(t, g), again)
				assertTrace(t, trace, again)
				if len(wireEvents) != 5 {
					t.Fatal("unexpected cleanup/release count", wireEvents)
				}
			}
		})
	}
}

func TestFunctionOwnershipParity(t *testing.T) {
	core := talk.New()
	var trace traceLines
	g := core.NewGroup(talk.GroupOptions{Name: "g", Trace: &trace})
	const source = "on go n\n return given x: x + n\nend go"
	s := nativeLoad(t, g, source, nil)
	trace = nil
	p := nativeRequest(t, s, talk.Int(5))
	native := nativePump(t, g)
	fn, failure := p.Result()
	if failure != nil || fn.Kind() != talk.KindFunction {
		t.Fatal(fn, failure)
	}
	h := newHost(t)
	h.ok("new-group", obj{"group": "g", "name": "g", "trace": true})
	h.ok("load", obj{"group": "g", "name": "s", "source": source})
	requested := h.frame("request", obj{"group": "g", "to": obj{"script": "s"}, "message": obj{"name": "go", "args": []any{5}}}, true)
	made := h.pump("g")
	wireFn := end(t, made)["result"]
	parts := wireFn.(map[string]any)["$function"].([]any)
	if len(parts) != 3 || parts[0] != "s" || parts[2] == "" || field(t, made, "ok")["fuelUsed"] != float64(native.FuelUsed) {
		t.Fatal(made)
	}
	assertTrace(t, trace, requested, made)
	trace = nil
	_, called, err := g.Call(nil, fn, []talk.Value{talk.Int(37)}, nil)
	if err != nil {
		t.Fatal(err)
	}
	admitted := h.frame("call", obj{"group": "g", "fn": wireFn, "args": []any{37}}, true)
	native = nativePump(t, g)
	done := h.pump("g")
	value, failure := called.Result()
	if failure != nil || !value.Equal(talk.Int(42)) || end(t, done)["result"] != float64(42) {
		t.Fatal(value, failure, done)
	}
	assertPump(t, native, done)
	assertTrace(t, trace, admitted, done)
	other := core.NewGroup(talk.GroupOptions{})
	h.ok("new-group", obj{"group": "other", "name": "other"})
	_, _, err = other.Call(nil, fn, nil, nil)
	var hostErr *talk.HostError
	if !errors.As(err, &hostErr) || hostErr.Code != talk.WrongGroup {
		t.Fatal(err)
	}
	if field(t, h.frame("call", obj{"group": "other", "fn": wireFn}, true), "err")["code"] != "wrong group" {
		t.Fatal("foreign Function admitted")
	}
	// Recursive argument validation must also catch a Function nested in a List.
	otherScript := nativeLoad(t, other, "on go x\n return 1\nend go", nil)
	_, _, err = otherScript.Request(nil, talk.Message{Name: "go", Args: []talk.Value{talk.List(talk.List(fn))}})
	if !errors.As(err, &hostErr) || hostErr.Code != talk.WrongGroup {
		t.Fatal(err)
	}
	h.ok("load", obj{"group": "other", "name": "s", "source": "on go x\n return 1\nend go"})
	if field(t, h.frame("request", obj{"group": "other", "to": obj{"script": "s"}, "message": obj{"name": "go", "args": []any{[]any{[]any{wireFn}}}}}, true), "err")["code"] != "wrong group" {
		t.Fatal("nested foreign Function admitted")
	}
	if _, err = s.Reload(source, talk.ResetVariables); err != nil {
		t.Fatal(err)
	}
	h.ok("reload", obj{"group": "g", "script": "s", "source": source, "carry": "reset variables"})
	trace = nil
	_, stale, err := g.Call(nil, fn, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	admitted = h.frame("call", obj{"group": "g", "fn": wireFn}, true)
	native = nativePump(t, g)
	done = h.pump("g")
	_, failure = stale.Result()
	if failure == nil || failure.Code != "send failed" || failure.Data.Get("reason").String() != `"function gone"` {
		t.Fatal(failure)
	}
	assertPump(t, native, done)
	assertTrace(t, trace, admitted, done)
}

func TestObjectIdentityAndDisposalParity(t *testing.T) {
	core := talk.New()
	kind, err := core.DefineObjectKind(talk.ObjectKindDef{Name: "room"})
	if err != nil {
		t.Fatal(err)
	}
	var trace traceLines
	g := core.NewGroup(talk.GroupOptions{Name: "g", Trace: &trace})
	object, err := g.Object(kind, "hall", new(int))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = g.Object(kind, "hall", nil); err == nil {
		t.Fatal("duplicate Object id admitted")
	}
	found, ok := g.ObjectByID("room", "hall")
	if !ok || found != object {
		t.Fatal("Object handle identity lost")
	}
	const source = "on go\n return room\nend go"
	s, err := g.Load(talk.LoadOptions{Name: "s", Source: source, Owner: object, Objects: map[string]*talk.Object{"room": object}})
	if err != nil {
		t.Fatal(err)
	}
	trace = nil
	pending := nativeRequest(t, s)
	native := nativePump(t, g)
	value, failure := pending.Result()
	if failure != nil || !value.Equal(object.Value()) {
		t.Fatal(value, failure)
	}
	h := newHost(t)
	h.ok("define-object-kind", obj{"name": "room", "props": []any{}})
	h.ok("new-group", obj{"group": "g", "name": "g", "trace": true})
	h.ok("object", obj{"group": "g", "kind": "room", "id": "hall"})
	wire := obj{"$object": []string{"room", "hall"}}
	if field(t, h.frame("object", obj{"group": "g", "kind": "room", "id": "hall"}, true), "err")["code"] != "duplicate object id" {
		t.Fatal("duplicate wire Object id admitted")
	}
	h.ok("load", obj{"group": "g", "name": "s", "source": source, "owner": wire, "objects": obj{"room": wire}})
	requested := h.frame("request", obj{"group": "g", "to": obj{"script": "s"}, "message": obj{"name": "go"}}, true)
	done := h.pump("g")
	assertPump(t, native, done)
	assertTrace(t, trace, requested, done)
	trace = nil
	if err = g.Dispose(object); err != nil {
		t.Fatal(err)
	}
	if err = g.Dispose(object); err != nil {
		t.Fatal(err)
	}
	first := h.frame("dispose", obj{"group": "g", "object": wire}, true)
	second := h.frame("dispose", obj{"group": "g", "object": wire}, true)
	native = nativePump(t, g)
	done = h.pump("g")
	assertPump(t, native, done)
	assertTrace(t, trace, first, second, done)
	if found, ok = g.ObjectByID("room", "hall"); !ok || found != object {
		t.Fatal("disposed Object lost identity")
	}
	if !value.Equal(object.Value()) {
		t.Fatal("disposed Value identity changed")
	}
}
