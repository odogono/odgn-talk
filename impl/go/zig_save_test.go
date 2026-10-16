//go:build talk_zig_experimental

package northtalk

import (
	"strings"
	"testing"
)

// A transport fixture supplies the live participant that the public scoped
// Capability attachment slice (#1050) will expose. The Save being checked is
// the ordinary public Group.Save, including its refusal Trace and attempt id.
func TestZigBackendSaveRefusesLiveEffects(t *testing.T) {
	var trace lines
	g := New().NewGroup(GroupOptions{Trace: &trace})
	b := g.backend.(*zigGroup)
	for _, step := range []struct {
		method string
		fields map[string]any
	}{
		{"define-capability", map[string]any{"name": "resource", "segmentLifecycle": true, "ops": []any{map[string]any{"name": "touch", "mode": "immediate", "result": "nothing", "segmentBound": true}}}},
		{"grant", map[string]any{"capability": "resource", "ops": "all"}},
		{"load", map[string]any{"name": "s", "source": "on go\n ask api to touch\n repeat forever\n end repeat\nend go\n", "grants": map[string]any{"api": 1}}},
		{"deliver", map[string]any{"to": map[string]any{"script": "s"}, "message": map[string]any{"name": "go"}}},
	} {
		if _, err := b.send(step.method, step.fields); err != nil {
			t.Fatal(err)
		}
	}
	fields := map[string]any{"m": "pump", "ref": int64(100), "group": "g", "now": "2026-10-15T12:00:00Z", "fuelSlice": 30}
	completed := false
	for i := 0; i < 10; i++ {
		b.frameMu.Lock()
		packet, err := b.frame(fields)
		b.frameMu.Unlock()
		if err != nil {
			t.Fatal(err)
		}
		b.observe(packet, fields["m"].(string))
		if packet.Get("err").Kind() != KindNothing {
			t.Fatal(packet)
		}
		need := packet.Get("need")
		if need.Kind() == KindNothing {
			completed = true
			break
		}
		switch zigText(need.Get("m")) {
		case "trace":
			fields = map[string]any{"m": "trace-result", "ref": int64(100)}
		case "effect":
			fields = map[string]any{"m": "effect-result", "ref": int64(100), "status": "ok"}
		case "op":
			fields = map[string]any{"m": "op-result", "ref": int64(100), "result": nil}
		default:
			t.Fatal(need)
		}
	}
	if !completed {
		t.Fatal("fixture did not finish its Pump")
	}
	trace = nil
	saved, err := g.Save()
	if host, ok := err.(*HostError); !ok || host.Code != EffectsPending || saved != nil {
		t.Fatal(saved, err)
	}
	if len(trace) != 2 || trace[0] != "> save s1" || trace[1] != `refused code="effects pending"` {
		t.Fatal(trace)
	}
	// A refusal advances only the attempt counter and leaves live state intact.
	_, err = g.Save()
	if host, ok := err.(*HostError); !ok || host.Code != EffectsPending || !strings.Contains(strings.Join(trace, "\n"), "> save s2") {
		t.Fatal(trace, err)
	}
}
