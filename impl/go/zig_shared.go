//go:build talk_zig_experimental

package northtalk

// SPIKE (#1103): Groups sharing a pool of guests instead of one guest each.
// NORTHTALK_ZIG_SHARED=n puts every new (not restored) Group on one of its
// Core's n guests, round-robin. Pools are never freed. Each Group has its own exchange
// (group-exchanges-v1), so the guest is held for one frame at a time, and a
// collected Group is dropped from its guest.

import (
	"context"
	"fmt"
	"os"
	"runtime"
	"strconv"
	"sync"
	"sync/atomic"

	"github.com/odogono/odgn-talk/impl/go/internal/zigwasm"
)

type zigShared struct {
	mu       sync.Mutex
	owner    atomic.Pointer[zigGroup]
	reactor  *zigwasm.Reactor
	hello    sync.Once
	helloErr error
	groups   atomic.Int64
	// Session-scoped registrations, shared by every Group on this guest.
	kinds       map[string]*ObjectKind
	libraries   map[[32]byte]bool
	definitions map[*CapabilityDef]string
}

// A guest session registers Object Kinds and Capabilities by name, as a Core
// does, so each Core has its own pool.
type zigGuestPool struct {
	once   sync.Once
	shared []*zigShared
	next   atomic.Uint64
}

var zigPools sync.Map // *Core → *zigGuestPool

var zigPoolSize, _ = strconv.Atoi(os.Getenv("NORTHTALK_ZIG_SHARED"))

func zigSharedGuest(c *Core) *zigShared {
	if zigPoolSize <= 0 {
		return nil
	}
	v, _ := zigPools.LoadOrStore(c, &zigGuestPool{})
	pool := v.(*zigGuestPool)
	pool.once.Do(func() {
		for range zigPoolSize {
			s := &zigShared{kinds: map[string]*ObjectKind{}, libraries: map[[32]byte]bool{}, definitions: map[*CapabilityDef]string{}}
			reactor, err := zigEngine().InstantiateObserved(context.Background(), func(event []byte) ([]byte, error) {
				live := s.owner.Load()
				if live == nil {
					return nil, fmt.Errorf("inline event with no owning Group")
				}
				return live.inlineEvent(event)
			})
			if err != nil {
				panic(err)
			}
			s.reactor = reactor
			pool.shared = append(pool.shared, s)
		}
	})
	return pool.shared[pool.next.Add(1)%uint64(len(pool.shared))]
}

func newZigSharedBackend(g *Group, s *zigShared) *zigGroup {
	b := &zigGroup{group: g, shared: s, reactor: s.reactor, handle: fmt.Sprintf("g%d", s.groups.Add(1)), inlineWake: make(chan struct{}, 1), pending: map[DeliveryID]*Pending{}, decisions: map[string]*Deciding{}, kinds: s.kinds, libraries: s.libraries, runs: map[RunID]DeliveryID{}, coordinators: map[*SegmentLifecycle]string{}, effectDetails: map[string]string{}, definitions: s.definitions, calls: map[CallID]context.CancelFunc{}, failureDetails: map[CallID]string{}}
	s.hello.Do(func() { s.helloErr = b.checkHello() })
	if s.helloErr != nil {
		panic(s.helloErr)
	}
	runtime.AddCleanup(g, dropShared, zigDrop{s, b.handle})
	return b
}

// shareFrame sends one frame to b's shared guest. With group-exchanges-v1
// each Group's exchange is its own, so the guest is held only for the frame,
// and inline events during it belong to b.
func (b *zigGroup) shareFrame(data []byte) ([]byte, error) {
	s := b.shared
	s.mu.Lock()
	defer s.mu.Unlock()
	s.owner.Store(b)
	defer s.owner.Store(nil)
	return s.reactor.Frame(context.Background(), data)
}

// dropShared frees a collected Group's guest state. It must not refer to
// the Group, or the Group would never be collected.
func dropShared(d zigDrop) {
	d.shared.mu.Lock()
	defer d.shared.mu.Unlock()
	data, _ := zigJSON(nil, map[string]any{"m": "drop-group", "ref": 0, "group": d.handle})
	d.shared.reactor.Frame(context.Background(), data)
}

type zigDrop struct {
	shared *zigShared
	handle string
}
