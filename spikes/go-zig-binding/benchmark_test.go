package zigprobe

import (
	"context"
	"testing"
	"time"

	talk "github.com/odogono/odgn-talk/impl/go"
)

// Both paths request and pump the same Script, checking its result on every
// iteration. The binding path includes JSON encoding/decoding and Reports;
// native Go uses the public API directly. Compilation and loading are untimed.
func BenchmarkImmediate(b *testing.B) {
	const source = "on go\n ask api to read\n return it + 1\nend go"
	b.Run("native-go", func(b *testing.B) {
		c := talk.New()
		def, err := c.DefineCapability("api", talk.Operation{Name: "read", Mode: talk.Immediate, Result: talk.NumberShape, Do: func(*talk.Call, []talk.Value) (talk.Value, error) { return talk.Int(41), nil }})
		if err != nil {
			b.Fatal(err)
		}
		g := c.NewGroup(talk.GroupOptions{})
		s, err := g.Load(talk.LoadOptions{Name: "s", Source: source, Grants: map[string]*talk.Grant{"api": def.GrantAll(nil)}})
		if err != nil {
			b.Fatal(err)
		}
		now := time.Date(2026, 10, 14, 12, 0, 0, 0, time.UTC)
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_, p, err := s.Request(nil, talk.Message{Name: "go"})
			if err != nil {
				b.Fatal(err)
			}
			if _, err = g.Pump(now, talk.PumpOptions{}); err != nil {
				b.Fatal(err)
			}
			v, failure := p.Result()
			if failure != nil || !v.Equal(talk.Int(42)) {
				b.Fatal(v, failure)
			}
		}
	})
	b.Run("zig-message-wazero", func(b *testing.B) {
		h := newHost(b)
		h.setup("immediate", source)
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			h.request("g")
			need := field(b, h.pump("g"), "need")
			if need["operation"] != "read" {
				b.Fatal(need)
			}
			row := end(b, h.result("op-result", obj{"result": 41}))
			if row["result"] != float64(42) {
				b.Fatal(row)
			}
		}
	})
}
func BenchmarkColdCompile(b *testing.B) {
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		e, err := NewEngine(context.Background())
		if err != nil {
			b.Fatal(err)
		}
		if err = e.Close(context.Background()); err != nil {
			b.Fatal(err)
		}
	}
}
func BenchmarkInstantiate(b *testing.B) {
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		r, err := engine.Instantiate(context.Background())
		if err != nil {
			b.Fatal(err)
		}
		if err = r.Close(context.Background()); err != nil {
			b.Fatal(err)
		}
	}
}
