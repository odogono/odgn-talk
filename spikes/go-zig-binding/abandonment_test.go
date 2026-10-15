package zigprobe

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	talk "github.com/odogono/odgn-talk/impl/go"
)

// A cleanup callback can inspect whether prior work was cancelled. The Host
// must learn abandonment before invoking that callback, not at Pump's return.
func TestAbandonmentPrecedesCleanupParity(t *testing.T) {
	core := talk.New()
	var active *talk.Call
	api, err := core.DefineCapability("api", talk.Operation{Name: "read", Mode: talk.Suspending, Result: talk.NumberShape, MaxPending: 5 * time.Second, Start: func(c *talk.Call, _ []talk.Value) error { active = c; return nil }})
	if err != nil {
		t.Fatal(err)
	}
	rollback := func(ctx context.Context) talk.EffectResult {
		if !errors.Is(ctx.Err(), context.Canceled) {
			t.Fatal("cleanup ran before pending work was cancelled")
		}
		return talk.EffectResult{Status: talk.EffectOK}
	}
	effectOK := func(talk.SegmentContext) talk.EffectResult { return talk.EffectResult{Status: talk.EffectOK} }
	resource, err := core.DefineSegmentCapability("resource", talk.SegmentLifecycle{Begin: effectOK, Commit: effectOK, Rollback: func(talk.SegmentContext) talk.EffectResult { return rollback(active.Context()) }}, talk.Operation{Name: "write", Mode: talk.Immediate, SegmentBound: true, Result: talk.NothingShape, Do: func(*talk.Call, []talk.Value) (talk.Value, error) { return talk.Nothing, nil }})
	if err != nil {
		t.Fatal(err)
	}
	var trace traceLines
	g := core.NewGroup(talk.GroupOptions{Name: "g", Trace: &trace})
	const pendingSource = "on go\n ask api to read and wait\n return it\nend go"
	const workSource = "on hold\n ask r to write\n repeat forever\n end repeat\nend hold"
	s := nativeLoad(t, g, pendingSource, map[string]*talk.Grant{"api": api.GrantAll(nil)})
	other, err := g.Load(talk.LoadOptions{Name: "other", Source: workSource, Grants: map[string]*talk.Grant{"r": resource.GrantAll(nil)}})
	if err != nil {
		t.Fatal(err)
	}
	trace = nil
	nativeRequest(t, s)
	if _, err = other.Deliver(talk.Message{Name: "hold"}); err != nil {
		t.Fatal(err)
	}
	first, err := g.Pump(parityNow, talk.PumpOptions{FuelSlice: 20})
	if err != nil {
		t.Fatal(err)
	}
	if first.State != talk.Sliced || active == nil || active.Context().Err() != nil {
		t.Fatal("fixture did not leave both pending work and a live Segment", first)
	}
	h := newHost(t)
	enableEarlyAbandonment(h)
	h.setupTrace("suspending", pendingSource, true)
	h.ok("define-capability", obj{"name": "resource", "segmentLifecycle": true, "ops": []obj{{"name": "write", "mode": "immediate", "result": "nothing", "segmentBound": true}}})
	grant := h.ok("grant", obj{"capability": "resource", "ops": "all"})["grant"]
	h.ok("load", obj{"group": "g", "name": "other", "source": workSource, "grants": obj{"r": grant}})
	requested := h.frame("request", obj{"group": "g", "to": obj{"script": "s"}, "message": obj{"name": "go"}}, true)
	delivered := h.frame("deliver", obj{"group": "g", "to": obj{"script": "other"}, "message": obj{"name": "hold"}}, true)
	starting := h.frame("pump", obj{"group": "g", "now": parityNow.Format("2006-01-02T15:04:05Z07:00"), "fuelSlice": 20}, true)
	call := field(t, starting, "need")["call"].(string)
	started := h.result("op-result", obj{"started": true})
	if field(t, started, "need")["phase"] != "begin" {
		t.Fatal(started)
	}
	begun := h.result("effect-result", obj{"status": "ok"})
	if field(t, begun, "need")["operation"] != "write" {
		t.Fatal(begun)
	}
	workCtx, cancel := context.WithCancel(context.Background())
	defer cancel()
	working := h.result("op-result", obj{"result": nil})
	assertPump(t, first, working)
	assertTrace(t, trace, requested, delivered, starting, started, begun, working)
	trace = nil
	s.Stop("cancel work")
	other.Stop("cleanup")
	native := nativePump(t, g)
	stopped := h.frame("stop", obj{"group": "g", "script": "s", "reason": "cancel work"}, true)
	cleaned := h.frame("stop", obj{"group": "g", "script": "other", "reason": "cleanup"}, true)
	cleaning := h.pump("g")
	need := field(t, cleaning, "need")
	if need["m"] != "effect" || need["phase"] != "rollback" {
		t.Fatal(cleaning)
	}
	if workCtx.Err() != nil {
		t.Fatal("Host work cancelled before abandonment was received")
	}
	abandoned := slice(cleaning["abandoned"])
	if len(abandoned) != 1 || abandoned[0] != call {
		t.Fatalf("cleanup need omitted prior Call abandonment: %v", cleaning)
	}
	cancel()
	status := rollback(workCtx)
	done := h.result("effect-result", obj{"status": string(status.Status)})
	if len(slice(field(t, done, "ok")["abandoned"])) != 0 {
		t.Fatal("abandonment repeated", done)
	}
	assertPump(t, native, done)
	assertTrace(t, trace, stopped, cleaned, cleaning, done)
}

func TestAbandonmentPrecedesFollowingCallbackParity(t *testing.T) {
	for _, kind := range []string{"op", "prop", "release"} {
		t.Run(kind, func(t *testing.T) {
			core := talk.New()
			var active *talk.Call
			observe := func(ctx context.Context) {
				t.Helper()
				if !errors.Is(ctx.Err(), context.Canceled) {
					t.Fatal("Host callback observed live abandoned work")
				}
			}
			options := []talk.CapabilityOption{talk.Operation{Name: "read", Mode: talk.Suspending, Result: talk.NumberShape, MaxPending: 5 * time.Second, Start: func(c *talk.Call, _ []talk.Value) error { active = c; return nil }}}
			if kind == "release" {
				options = append(options, talk.WithReleaseHook(func(talk.GrantContext) { observe(active.Context()) }))
			}
			api, err := core.DefineCapability("api", options...)
			if err != nil {
				t.Fatal(err)
			}
			var trace traceLines
			g := core.NewGroup(talk.GroupOptions{Name: "g", Trace: &trace})
			const source = "on go\n ask api to read and wait\n return it\nend go"
			s := nativeLoad(t, g, source, map[string]*talk.Grant{"api": api.GrantAll(nil)})
			h := newHost(t)
			enableEarlyAbandonment(h)
			h.ok("define-capability", obj{"name": "api", "release": kind == "release", "ops": []obj{{"name": "read", "mode": "suspending", "result": "number", "maxPending": 5000}}})
			grant := h.ok("grant", obj{"capability": "api", "ops": "all"})["grant"]
			h.ok("new-group", obj{"group": "g", "name": "g", "trace": true})
			h.ok("load", obj{"group": "g", "name": "s", "source": source, "grants": obj{"api": grant}})
			var observer *talk.Script
			if kind != "release" {
				load := talk.LoadOptions{Name: "observer"}
				wireLoad := obj{"group": "g", "name": "observer"}
				if kind == "op" {
					def, err := core.DefineCapability("observer", talk.Operation{Name: "observe", Mode: talk.Immediate, Result: talk.NumberShape, Do: func(*talk.Call, []talk.Value) (talk.Value, error) {
						observe(active.Context())
						return talk.Int(42), nil
					}})
					if err != nil {
						t.Fatal(err)
					}
					load.Source = "on go\n ask api to observe\n return it\nend go"
					load.Grants = map[string]*talk.Grant{"api": def.GrantAll(nil)}
					h.ok("define-capability", obj{"name": "observer", "ops": []obj{{"name": "observe", "mode": "immediate", "result": "number"}}})
					wireLoad["grants"] = obj{"api": h.ok("grant", obj{"capability": "observer", "ops": "all"})["grant"]}
				} else {
					objectKind, err := core.DefineObjectKind(talk.ObjectKindDef{Name: "box", Props: []talk.Prop{{Name: "value", Shape: talk.NumberShape, Get: func(*talk.Object) (talk.Value, error) { observe(active.Context()); return talk.Int(42), nil }}}})
					if err != nil {
						t.Fatal(err)
					}
					object, err := g.Object(objectKind, "one", nil)
					if err != nil {
						t.Fatal(err)
					}
					load.Source = "on go\n return the value of box\nend go"
					load.Objects = map[string]*talk.Object{"box": object}
					h.ok("define-object-kind", obj{"name": "box", "props": []obj{{"name": "value", "shape": "number", "readOnly": true}}})
					h.ok("object", obj{"group": "g", "kind": "box", "id": "one"})
					wireLoad["objects"] = obj{"box": obj{"$object": []string{"box", "one"}}}
				}
				observer, err = g.Load(load)
				if err != nil {
					t.Fatal(err)
				}
				wireLoad["source"] = load.Source
				h.ok("load", wireLoad)
			}
			nativeRequest(t, s)
			nativePump(t, g)
			h.request("g")
			call := field(t, h.pump("g"), "need")["call"].(string)
			field(t, h.result("op-result", obj{"started": true}), "ok")
			work, cancel := context.WithCancel(context.Background())
			defer cancel()
			trace = nil
			s.Stop("done")
			replies := []obj{h.frame("stop", obj{"group": "g", "script": "s", "reason": "done"}, true)}
			if observer != nil {
				nativeRequest(t, observer)
				replies = append(replies, h.frame("request", obj{"group": "g", "to": obj{"script": "observer"}, "message": obj{"name": "go"}}, true))
			}
			native := nativePump(t, g)
			paused := h.pump("g")
			replies = append(replies, paused)
			if field(t, paused, "need")["m"] != kind {
				t.Fatal(paused)
			}
			ids := slice(paused["abandoned"])
			if len(ids) != 1 || ids[0] != call {
				t.Fatalf("%s omitted abandonment: %v", kind, paused)
			}
			if work.Err() != nil {
				t.Fatal("work cancelled before notification")
			}
			cancel()
			observe(work)
			worker := h.ref
			// A rejected result leaves the need live and must not repeat notification.
			invalid := h.at(worker+100, "op-result", obj{"result": 42})
			if field(t, invalid, "err")["kind"] != "protocol error" || len(slice(invalid["abandoned"])) != 0 {
				t.Fatal(invalid)
			}
			malformed, err := h.r.Frame(context.Background(), []byte(`{"m":"op-result","ref":`))
			if err != nil {
				t.Fatal(err)
			}
			var refused obj
			if err = json.Unmarshal(malformed, &refused); err != nil {
				t.Fatal(err)
			}
			if field(t, refused, "err")["kind"] != "protocol error" || len(slice(refused["abandoned"])) != 0 {
				t.Fatal(refused)
			}
			message, payload := "op-result", obj{"result": 42}
			if kind == "prop" {
				message, payload = "prop-result", obj{"value": 42}
			}
			if kind == "release" {
				message, payload = "release-result", nil
			}
			done := h.at(worker, message, payload)
			replies = append(replies, done)
			if len(slice(field(t, done, "ok")["abandoned"])) != 0 {
				t.Fatal("notification repeated", done)
			}
			assertPump(t, native, done)
			assertTrace(t, trace, replies...)
			trace = nil
			again := h.pump("g")
			assertPump(t, nativePump(t, g), again)
			assertTrace(t, trace, again)
			if len(slice(field(t, again, "ok")["abandoned"])) != 0 {
				t.Fatal("notification repeated on next Pump", again)
			}
		})
	}
}

func enableEarlyAbandonment(h *host) {
	h.t.Helper()
	hello := h.ok("hello", obj{"protocol": 1, "features": []string{"abandoned-before-needs-v1"}})
	for _, feature := range slice(hello["features"]) {
		if feature == "abandoned-before-needs-v1" {
			return
		}
	}
	h.t.Fatal("reactor does not support cancellation before subsequent callbacks")
}

func TestFatalWorkerErrorPublishesAbandonment(t *testing.T) {
	h := newHost(t)
	enableEarlyAbandonment(h)
	h.setupTrace("suspending", "on go\n ask api to read and wait\nend go", false)
	h.ok("define-capability", obj{"name": "resource", "segmentLifecycle": true, "ops": []obj{{"name": "write", "mode": "immediate", "result": "nothing", "segmentBound": true}}})
	grant := h.ok("grant", obj{"capability": "resource", "ops": "all"})["grant"]
	h.ok("load", obj{"group": "g", "name": "other", "source": "on go\n ask r to write\n repeat forever\n end repeat\nend go", "grants": obj{"r": grant}})
	h.request("g")
	h.ok("deliver", obj{"group": "g", "to": obj{"script": "other"}, "message": obj{"name": "go"}})
	starting := h.frame("pump", obj{"group": "g", "now": parityNow.Format(time.RFC3339Nano), "fuelSlice": 20}, true)
	call := field(t, starting, "need")["call"].(string)
	started := h.result("op-result", obj{"started": true})
	if field(t, started, "need")["phase"] != "begin" {
		t.Fatal(started)
	}
	begun := h.result("effect-result", obj{"status": "ok"})
	if field(t, begun, "need")["operation"] != "write" {
		t.Fatal(begun)
	}
	field(t, h.result("op-result", obj{"result": nil}), "ok")
	rollback := h.frame("reload", obj{"group": "g", "script": "other", "source": "on go\nend go", "carry": "reset variables"}, true)
	if field(t, rollback, "need")["phase"] != "rollback" || len(slice(rollback["abandoned"])) != 0 {
		t.Fatal(rollback)
	}
	// The unknown effect status stops the whole Group after this last need.
	// There is no later callback or successful reply to carry s's cancellation.
	failed := h.result("effect-result", obj{"status": "unknown"})
	if field(t, failed, "err")["code"] != "effect state unknown" {
		t.Fatal(failed)
	}
	ids := slice(failed["abandoned"])
	if len(ids) != 1 || ids[0] != call {
		t.Fatal("worker error lost abandonment", failed)
	}
	after := h.pump("g")
	if field(t, after, "ok")["state"] != "stopped" || len(slice(field(t, after, "ok")["abandoned"])) != 0 {
		t.Fatal(after)
	}
}
