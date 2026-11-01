package northtalk

import (
	"context"
	"errors"
	"testing"
	"time"
)

// An object made with a parent routes to the parent's owner without a
// queued SetParent, and a disposed or foreign parent is refused (ADR 0152).
func TestObjectWithParent(t *testing.T) {
	c := New()
	g := c.NewGroup(GroupOptions{})
	kind := objectKindForTest(t, c, "room")
	hall, _ := g.Object(kind, "hall", nil)
	if _, err := g.Load(LoadOptions{Name: "hall", Owner: hall, Source: "on ping\n  return the id of the target\nend ping"}); err != nil {
		t.Fatal(err)
	}
	lamp, err := g.Object(kind, "lamp", nil, WithParent(hall))
	if err != nil {
		t.Fatal(err)
	}
	_, p, err := g.Request(context.Background(), lamp, Message{Name: "ping"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := g.Pump(time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC), PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	if answer, failure := p.Result(); failure != nil || answer.String() != `"lamp"` {
		t.Fatalf("got %v, %v", answer, failure)
	}

	foreign, _ := c.NewGroup(GroupOptions{}).Object(kind, "x", nil)
	var he *HostError
	if _, err := g.Object(kind, "a", nil, WithParent(foreign)); !errors.As(err, &he) || he.Code != WrongGroup {
		t.Fatalf("foreign parent: %v", err)
	}
	if err := g.Dispose(lamp); err != nil {
		t.Fatal(err)
	}
	if _, err := g.Pump(time.Date(2026, 11, 1, 0, 0, 1, 0, time.UTC), PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, err := g.Object(kind, "a", nil, WithParent(lamp)); !errors.As(err, &he) || he.Code != InvalidValue {
		t.Fatalf("disposed parent: %v", err)
	}
	if _, err := g.Object(kind, "a", nil); err != nil {
		t.Fatalf("the refused id should stay free: %v", err)
	}
}
