package northtalk

import (
	"slices"
	"testing"
	"time"
)

// BenchmarkBackendRequestPump exercises the public combined-operation
// API on each backend. BackendRequest remains the unchanged public
// separate-call gate. Unsupported backends fail rather than report fallback
// timings under the combined operation's name.
func BenchmarkBackendRequestPump(b *testing.B) {
	g := New().NewGroup(GroupOptions{Name: "request-pump"})
	s, err := g.Load(LoadOptions{Name: "s", Source: "on ping n\n return n + 1\nend ping\n"})
	if err != nil {
		b.Fatal(err)
	}
	m := Message{Name: "ping", Args: []Value{Int(41)}}
	now := time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)
	times := make([]time.Duration, 0, 1<<16)
	b.ReportAllocs()
	for b.Loop() {
		start := time.Now()
		_, p, _, err := s.RequestPump(nil, m, now, PumpOptions{})
		if err != nil {
			b.Fatal(err)
		}
		if v, e := p.Result(); e != nil || !v.Equal(Int(42)) {
			b.Fatalf("%v %v", v, e)
		}
		times = append(times, time.Since(start))
	}
	slices.Sort(times)
	if len(times) > 0 {
		b.ReportMetric(float64(times[len(times)/2].Nanoseconds()), "p50-ns")
		b.ReportMetric(float64(times[min(len(times)-1, int(0.99*float64(len(times))))].Nanoseconds()), "p99-ns")
	}
}

// Function calls are recorded alongside Request without an additional gate.
func BenchmarkBackendCallPump(b *testing.B) {
	g := New().NewGroup(GroupOptions{Name: "call-pump"})
	s, err := g.Load(LoadOptions{Name: "s", Source: "on exported\n return given: 42\nend exported\n"})
	if err != nil {
		b.Fatal(err)
	}
	now := time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)
	_, exported, err := s.Request(nil, Message{Name: "exported"})
	if err != nil {
		b.Fatal(err)
	}
	if _, err := g.Pump(now, PumpOptions{}); err != nil {
		b.Fatal(err)
	}
	fn, failure := exported.Result()
	if failure != nil {
		b.Fatal(failure)
	}
	b.ReportAllocs()
	for b.Loop() {
		_, p, _, err := g.CallPump(nil, fn, nil, nil, now, PumpOptions{})
		if err != nil {
			b.Fatal(err)
		}
		if v, e := p.Result(); e != nil || !v.Equal(Int(42)) {
			b.Fatalf("%v %v", v, e)
		}
	}
}
