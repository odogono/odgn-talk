//go:build talk_zig_experimental

package northtalk

// SPIKE (#1103): Groups sharing a pool of guests instead of one guest each.
// NORTHTALK_ZIG_SHARED=n puts every new (not restored) Group on one of its
// Core's n guests, round-robin. Pools are never freed. A Group owns its guest from the first frame of a
// conversation until a reply with no need, so another Group on the same guest
// waits while it is paused at a Host callback. The guest has no way to drop a
// Group, so a shared guest keeps every Group it ever hosted.

import (
	"context"
	"fmt"
	"os"
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
	return b
}

// acquire makes b the guest's owner for a conversation. Only an export calls it.
func (b *zigGroup) acquire() {
	if b.shared == nil || b.holding {
		return
	}
	b.shared.mu.Lock()
	b.shared.owner.Store(b)
	b.holding = true
}

// releaseIdle gives the guest up once b's conversation has no pending need.
func (b *zigGroup) releaseIdle(failed bool) {
	if b.shared == nil || !b.holding {
		return
	}
	b.frameMu.Lock()
	open := b.needOpen
	b.frameMu.Unlock()
	if open && !failed {
		return
	}
	b.holding = false
	b.shared.owner.Store(nil)
	b.shared.mu.Unlock()
}
