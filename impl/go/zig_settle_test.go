package northtalk

import (
	"bytes"
	"context"
	"sync"
	"testing"
	"time"
)

// recordFrames notes each frame's method: a binary tag, or a JSON input's m.
func recordFrames(t *testing.T) func() []string {
	var mu sync.Mutex
	var seen []string
	zigFrameSeen = func(data []byte) {
		mu.Lock()
		defer mu.Unlock()
		if bytes.HasPrefix(data, zbPrefix[:3]) {
			seen = append(seen, "binary "+zbTagName(data[len(zbPrefix)+1]))
			return
		}
		root, err := zigParseReply(data)
		if err != nil {
			t.Error(err)
			return
		}
		seen = append(seen, "json "+zigText(root.get("m")))
	}
	t.Cleanup(func() { zigFrameSeen = nil })
	return func() []string {
		mu.Lock()
		defer mu.Unlock()
		out := seen
		seen = nil
		return out
	}
}

func zbTagName(tag byte) string {
	if m := zbEnvelopes[tag]; m.name != "" && (tag < zbOpResult || tag > zbReleaseResult) {
		return m.name
	}
	return "result"
}

// A deferred call's answer rides the next Pump: four exports, all binary
// (#1320). An input sent before that Pump carries the queue ahead of itself.
func TestZigBackendDeferredAnswerRidesThePump(t *testing.T) {
	core := New()
	started := make(chan *Call, 4)
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
	if !g.backend.(*zigGroup).reg.settlements {
		t.Skip("the guest did not take settlements-fields-v1")
	}
	frames := recordFrames(t)
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
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
	want := []string{"binary request", "binary settle-pump", "binary result", "binary settle-pump"}
	if got := frames(); !equalStrings(got, want) {
		t.Fatalf("frames = %q, want %q", got, want)
	}

	// An answer queued before another input crosses ahead of it.
	if _, _, err := s.Request(context.Background(), Message{Name: "go"}); err != nil {
		t.Fatal(err)
	}
	if _, err := g.Pump(now, PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	frames()
	(<-started).Answer(Int(1))
	if _, _, err := s.Request(context.Background(), Message{Name: "go"}); err != nil {
		t.Fatal(err)
	}
	if got, want := frames(), []string{"json answer", "binary request"}; !equalStrings(got, want) {
		t.Fatalf("frames = %q, want %q", got, want)
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// Queued Deliveries, Broadcasts and Decisions cross in binary, with the ids
// their JSON forms would return (#1374).
func TestZigBackendQueuedInputsAreBinary(t *testing.T) {
	core := New()
	g := core.NewGroup(GroupOptions{Name: "queued"})
	s, err := g.Load(LoadOptions{Name: "s", Source: "on ping\n return 1\nend ping\n"})
	if err != nil {
		t.Fatal(err)
	}
	if !g.backend.(*zigGroup).reg.queue {
		t.Skip("the guest did not take queue-fields-v1")
	}
	frames := recordFrames(t)
	delivered, err := s.Deliver(Message{Name: "ping"})
	if err != nil || delivered == "" {
		t.Fatal(delivered, err)
	}
	broadcast, err := g.Broadcast(Message{Name: "ping"})
	if err != nil || broadcast == "" {
		t.Fatal(broadcast, err)
	}
	decided, _, err := s.Decide(context.Background(), Message{Name: "ping"})
	if err != nil || decided == "" {
		t.Fatal(decided, err)
	}
	all, _, err := g.DecideBroadcast(context.Background(), Message{Name: "ping"})
	if err != nil || all == "" {
		t.Fatal(all, err)
	}
	want := []string{"binary deliver", "binary broadcast", "binary decide", "binary decide"}
	if got := frames(); !equalStrings(got, want) {
		t.Fatalf("frames = %q, want %q", got, want)
	}
	result, err := g.Pump(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	ends := map[DeliveryID]bool{}
	broadcasts := map[BroadcastID]bool{}
	for _, r := range result.Reports {
		if end, ok := r.(*RunEnd); ok {
			ends[end.Delivery] = true
			broadcasts[end.Broadcast] = true
		}
	}
	if !ends[delivered] || !broadcasts[broadcast] {
		t.Fatal(result.Reports, delivered, broadcast)
	}
}
