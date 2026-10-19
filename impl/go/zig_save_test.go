//go:build talk_zig_experimental

package northtalk

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestZigBackendRestoreRejectsMalformedSaves(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s := joinLoad(t, g, "s", "script variable cb = given x: x\nscript variable distance = 3 m\non spin\n repeat forever\n end repeat\nend spin", Limits{})
	s.Deliver(Message{Name: "spin"})
	if _, err := g.Pump(time.Unix(1, 0), PumpOptions{FuelSlice: 10}); err != nil {
		t.Fatal(err)
	}
	saved, err := g.Save()
	if err != nil {
		t.Fatal(err)
	}
	payload := zigSavePayload(t, saved)
	format, n := binary.Uvarint(payload[4:])
	if n <= 0 {
		t.Fatal("invalid save format header")
	}
	badMagic := bytes.Clone(payload)
	badMagic[0] = 'X'
	badDigest := bytes.Clone(saved)
	badDigest[len(badDigest)-1] ^= 1
	type malformedSave struct {
		name string
		save []byte
	}
	cases := []malformedSave{
		{"magic", signZigSave(badMagic)},
		{"digest", badDigest},
		{"truncated digest", saved[:len(saved)-1]},
		{"missing state", signZigSave(payload[:4+n])},
		{"extra state", signZigSave(append(bytes.Clone(payload), 0))},
	}
	// Every prior format must remain invalid even under VariablesOnly. Re-sign
	// each mutation so rejection tests the format, rather than its checksum.
	for old := uint64(0); old < format; old++ {
		out := binary.AppendUvarint(bytes.Clone(payload[:4]), old)
		out = append(out, payload[4+n:]...)
		cases = append(cases, malformedSave{fmt.Sprintf("format %d", old), signZigSave(out)})
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			for _, policy := range []MismatchPolicy{RejectMismatch, VariablesOnly} {
				t.Run(fmt.Sprint(policy), func(t *testing.T) {
					restored, result, err := New().Restore(tc.save, RestoreOptions{Mismatch: policy})
					host, ok := err.(*HostError)
					if !ok || host.Code != InvalidSave || restored != nil || len(result.Reports) != 0 {
						t.Fatalf("malformed save accepted: %v, %#v, %v", restored, result, err)
					}
				})
			}
		})
	}
}

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
	fields := map[string]any{"m": "pump", "ref": int64(100), "group": b.groupHandle(), "now": "2026-10-15T12:00:00Z", "fuelSlice": 30}
	completed := false
	for i := 0; i < 10; i++ {
		packet, err := b.frame(zigOut{fields: fields})
		if err != nil {
			t.Fatal(err)
		}
		b.observe(packet)
		if packet.failure != nil {
			t.Fatal(packet.failure)
		}
		// A binary need (#1311) still takes its JSON result.
		kind := ""
		if packet.need != nil {
			kind = packet.need.kind
		}
		if kind == "" {
			completed = true
			break
		}
		switch kind {
		case "trace":
			fields = map[string]any{"m": "trace-result", "ref": int64(100), "group": b.groupHandle()}
		case "effect":
			fields = map[string]any{"m": "effect-result", "ref": int64(100), "group": b.groupHandle(), "status": "ok"}
		case "op":
			fields = map[string]any{"m": "op-result", "ref": int64(100), "group": b.groupHandle(), "result": nil}
		default:
			t.Fatal(kind)
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
