//go:build talk_zig_experimental

package northtalk

import (
	"context"
	"runtime"
	"strings"
	"testing"
	"time"
)

var sharedNow = time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)

// zigGroupsOnOneGuest makes Groups until two share a guest.
func zigGroupsOnOneGuest(t *testing.T, c *Core) (*Group, *Group) {
	first := c.NewGroup(GroupOptions{Name: "first"})
	for range runtime.GOMAXPROCS(0) + 1 {
		g := c.NewGroup(GroupOptions{Name: "other"})
		if g.backend.(*zigGroup).shared == first.backend.(*zigGroup).shared {
			return first, g
		}
	}
	t.Fatal("no two Groups share a guest")
	return nil, nil
}

func TestZigBackendSharedGuestServesAnotherGroupDuringACallback(t *testing.T) {
	c := New()
	entered, release := make(chan struct{}), make(chan struct{})
	def, err := c.DefineCapability("api", Operation{Name: "hold", Mode: Immediate, Result: NumberShape, Do: func(*Call, []Value) (Value, error) {
		close(entered)
		<-release
		return Int(1), nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	held, other := zigGroupsOnOneGuest(t, c)
	s, err := held.Load(LoadOptions{Name: "s", Source: "on go\n ask api to hold\n return it\nend go\n", Grants: map[string]*Grant{"api": def.GrantAll(nil)}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Deliver(Message{Name: "go"}); err != nil {
		t.Fatal(err)
	}
	pumped := make(chan error, 1)
	go func() { _, err := held.Pump(sharedNow, PumpOptions{}); pumped <- err }()
	<-entered
	// The held Group waits in its callback; its guest still runs the other.
	o, err := other.Load(LoadOptions{Name: "s", Source: "on ping n\n return n + 1\nend ping\n"})
	if err != nil {
		t.Fatal(err)
	}
	_, p, err := o.Request(context.Background(), Message{Name: "ping", Args: []Value{Int(41)}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := other.Pump(sharedNow, PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	if v, failure := p.Result(); failure != nil || !v.Equal(Int(42)) {
		t.Fatal(v, failure)
	}
	close(release)
	if err := <-pumped; err != nil {
		t.Fatal(err)
	}
}

func TestZigBackendDropsCollectedGroupFromItsGuest(t *testing.T) {
	c := New()
	kept, dropped := zigGroupsOnOneGuest(t, c)
	if _, err := dropped.Load(LoadOptions{Name: "s", Source: "on ping\n return 1\nend ping\n"}); err != nil {
		t.Fatal(err)
	}
	guest, handle := kept.backend.(*zigGroup).shared, dropped.backend.(*zigGroup).handle
	dropped = nil
	inspect := []byte(`{"m":"inspect","ref":1,"group":"` + handle + `"}`)
	for range 100 {
		runtime.GC()
		guest.mu.Lock()
		reply, err := guest.reactor.Frame(context.Background(), inspect)
		guest.mu.Unlock()
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(reply), `"err"`) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("collected Group still in its guest")
}

func TestZigBackendMovesGroupRatherThanMeetARedefinedKind(t *testing.T) {
	c := New()
	define := func() *ObjectKind {
		k, err := c.DefineObjectKind(ObjectKindDef{Name: "light"})
		if err != nil {
			t.Fatal(err)
		}
		return k
	}
	old := define()
	first, second := zigGroupsOnOneGuest(t, c)
	newer := define()
	if _, err := first.Object(newer, "bulb", nil); err != nil {
		t.Fatal(err)
	}
	// second has done nothing yet, so it moves rather than refuse old.
	if _, err := second.Object(old, "lamp", nil); err != nil {
		t.Fatal(err)
	}
	if second.backend.(*zigGroup).shared == first.backend.(*zigGroup).shared {
		t.Fatal("second stayed on a guest holding the newer Kind")
	}
	// first has an Object now, so it can't move, and refuses old.
	if _, err := first.Object(old, "lamp", nil); err == nil {
		t.Fatal("first accepted a second Kind named light")
	}
}
