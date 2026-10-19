//go:build talk_zig_experimental

package northtalk

import (
	"context"
	"testing"
	"time"
)

// deferredCall makes one Request that suspends on an Operation another
// goroutine answers, pumping until the Request settles.
func deferredCall(t *testing.T, g *Group, s *Script, ready <-chan struct{}) {
	t.Helper()
	now := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	_, p, err := s.Request(context.Background(), Message{Name: "go"})
	if err != nil {
		t.Fatal(err)
	}
	for {
		if _, err := g.Pump(now, PumpOptions{}); err != nil {
			t.Fatal(err)
		}
		select {
		case <-p.Done():
			if v, failure := p.Result(); failure != nil || !v.Equal(Int(42)) {
				t.Fatalf("result %v, failure %v", v, failure)
			}
			return
		case <-ready:
		}
	}
}

// Settled deferred calls must not leave state behind, in the guest or in the
// adapter, including across the 200,000-call acceptance run (#1320, #1322).
func TestZigBackendDeferredCallsRetainNothing(t *testing.T) {
	core := New()
	started := make(chan *Call, 1)
	go func() {
		for c := range started {
			c.Answer(Int(41))
		}
	}()
	defer close(started)
	def, err := core.DefineCapability("api", Operation{
		Name: "read", Mode: Suspending, Result: NumberShape,
		Start: func(c *Call, _ []Value) error { started <- c; return nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	ready := make(chan struct{}, 1)
	g := core.NewGroup(GroupOptions{Name: "deferred", OnReady: func() {
		select {
		case ready <- struct{}{}:
		default:
		}
	}})
	s, err := g.Load(LoadOptions{Name: "s", Source: "on go\n ask api to read and wait\n return it + 1\nend go\n", Grants: map[string]*Grant{"api": def.GrantAll(nil)}})
	if err != nil {
		t.Fatal(err)
	}
	b := g.backend.(*zigGroup)
	for range 2000 {
		deferredCall(t, g, s, ready)
	}
	before := b.reactor.MemoryBytes()
	const callsPerBatch = 20000
	const batches = 10
	for batch := range batches {
		for range callsPerBatch {
			deferredCall(t, g, s, ready)
		}
		after := b.reactor.MemoryBytes()
		if after != before {
			t.Fatalf("guest memory grew from %d to %d bytes after %d deferred calls", before, after, (batch+1)*callsPerBatch)
		}
	}
	t.Logf("guest memory stayed at %d bytes across %d deferred calls", before, batches*callsPerBatch)
	b.callsMu.Lock()
	calls, failures, restored := len(b.calls), len(b.failureDetails), len(b.restoredCalls)
	b.callsMu.Unlock()
	if calls+failures+restored != 0 {
		t.Errorf("adapter retains %d calls, %d failure details, %d restored calls", calls, failures, restored)
	}
}
