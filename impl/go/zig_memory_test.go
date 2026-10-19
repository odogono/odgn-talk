//go:build talk_zig_experimental

package northtalk

import (
	"context"
	"testing"
	"time"
)

// zigMemoryBytes is the guest's linear memory, shared or its own.
func zigMemoryBytes(b *zigGroup) uint32 {
	if b.shared != nil {
		return b.shared.reactor.MemoryBytes()
	}
	return b.reactor.MemoryBytes()
}

// A long-lived Group's guest memory stays flat across deferred calls: their
// Calls are released once answered, and their issued ids fold (#1320).
func TestZigBackendDeferredCallsKeepGuestMemoryFlat(t *testing.T) {
	core := New()
	started := make(chan *Call, 1)
	def, err := core.DefineCapability("api", Operation{
		Name: "read", Mode: Suspending, Result: NumberShape,
		Start: func(c *Call, _ []Value) error { started <- c; return nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	g := core.NewGroup(GroupOptions{Name: "deferred"})
	s, err := g.Load(LoadOptions{Name: "s", Source: "on go\n ask api to read and wait\n return it + 1\nend go\n", Grants: map[string]*Grant{"api": def.GrantAll(nil)}})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	calls := func(n int) {
		for range n {
			_, p, err := s.Request(context.Background(), Message{Name: "go"})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := g.Pump(now, PumpOptions{}); err != nil {
				t.Fatal(err)
			}
			(<-started).Answer(Int(41))
			if _, err := g.Pump(now, PumpOptions{}); err != nil {
				t.Fatal(err)
			}
			if v, err := p.Result(); err != nil || !v.Equal(Int(42)) {
				t.Fatal(v, err)
			}
		}
	}
	calls(2000)
	before := zigMemoryBytes(g.backend.(*zigGroup))
	calls(20000)
	if after := zigMemoryBytes(g.backend.(*zigGroup)); after > before {
		t.Fatalf("guest memory grew from %d to %d bytes over 20,000 deferred calls", before, after)
	}
}
