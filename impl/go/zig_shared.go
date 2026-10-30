package northtalk

// A Core's Groups share a small pool of guests instead of one guest each
// (#1103). A guest is one Message Layer Session: it holds the Core's
// declarations once, and with group-exchanges-v1 each Group on it has its own
// exchange, so a Group holds the guest only for one frame at a time, even
// while it waits on a Host callback. A collected Group is dropped from its
// guest, and a guest no Group or pool uses is closed. A restored Group keeps
// a guest of its own.

import (
	"context"
	"fmt"
	"maps"
	"runtime"
	"strconv"
	"sync"
	"weak"

	"northtalk.org/go/internal/zigwasm"
)

// zigRegistry is what a guest's Session has been told, shared by every Group
// on it: Object Kinds by name, compiled Libraries by identity, and each
// Capability definition's handle.
type zigRegistry struct {
	kindsMu       sync.Mutex
	kinds         map[string]*ObjectKind
	librariesMu   sync.Mutex
	libraries     map[[32]byte]bool
	definitionsMu sync.Mutex
	definitions   map[*CapabilityDef]string
	// elements is whether the guest offered object-elements-v1 (#1143).
	elements bool
	// binary is whether the guest took request-pump-fields-v1 (#1245), so
	// Request, Function call and Pump frames are binary.
	binary bool
	// settlements is whether the guest took settlements-fields-v1 (#1320).
	settlements bool
	// load is whether the guest took load-fields-v1 (#1329).
	load bool
	// queue is whether the guest took queue-fields-v1 (#1374), so queued
	// Deliveries, Broadcasts and Decisions are binary.
	queue bool
}

func newZigRegistry() *zigRegistry {
	return &zigRegistry{kinds: map[string]*ObjectKind{}, libraries: map[[32]byte]bool{}, definitions: map[*CapabilityDef]string{}}
}

// define returns def's handle, calling declare to send its declaration the
// first time.
func (r *zigRegistry) define(def *CapabilityDef, declare func(handle string) error) (string, error) {
	r.definitionsMu.Lock()
	defer r.definitionsMu.Unlock()
	if handle, ok := r.definitions[def]; ok {
		return handle, nil
	}
	handle := fmt.Sprintf("go-capability-%d", len(r.definitions)+1)
	if err := declare(handle); err != nil {
		return "", err
	}
	r.definitions[def] = handle
	return handle, nil
}

func (r *zigRegistry) handle(def *CapabilityDef) string {
	r.definitionsMu.Lock()
	defer r.definitionsMu.Unlock()
	return r.definitions[def]
}

func (r *zigRegistry) definitionName(handle string) (string, bool) {
	r.definitionsMu.Lock()
	defer r.definitionsMu.Unlock()
	for def, h := range r.definitions {
		if h == handle {
			return def.name, true
		}
	}
	return "", false
}

// conflicts reports whether the guest holds a different Kind under one of
// kinds' names. A Core may redefine a name; its Groups made since then need
// a guest that never saw the old Kind, as a guest of their own would be.
func (r *zigRegistry) conflicts(kinds map[string]*ObjectKind) bool {
	r.kindsMu.Lock()
	defer r.kindsMu.Unlock()
	for name, known := range r.kinds {
		if k, ok := kinds[name]; ok && k != known {
			return true
		}
	}
	return false
}

func (r *zigRegistry) kindFree(kind *ObjectKind) bool {
	r.kindsMu.Lock()
	defer r.kindsMu.Unlock()
	known, ok := r.kinds[kind.name]
	return !ok || known == kind
}

// zigShared is one guest and the Groups' turn at it.
type zigShared struct {
	mu sync.Mutex
	// The Group whose frame holds mu, which inline events belong to.
	owner    *zigGroup
	reactor  *zigwasm.Reactor
	reg      *zigRegistry
	hello    sync.Once
	helloErr error
	groups   int
}

func newZigShared() *zigShared {
	s := &zigShared{reg: newZigRegistry()}
	// The observer must not keep s alive, or the cleanup below never runs.
	live := weak.Make(s)
	reactor, err := zigEngine().InstantiateObserved(context.Background(), func(event []byte) ([]byte, error) {
		s := live.Value()
		if s == nil || s.owner == nil {
			return nil, fmt.Errorf("inline event with no Group's frame running")
		}
		return s.owner.inlineEvent(event)
	})
	if err != nil {
		panic(err)
	}
	s.reactor = reactor
	runtime.AddCleanup(s, func(r *zigwasm.Reactor) { r.Close(context.Background()) }, reactor)
	return s
}

// zigGuestPool is a Core's guests, one slot per processor, each filled when
// a Group first needs it.
type zigGuestPool struct {
	mu     sync.Mutex
	guests []*zigShared
	next   int
}

// zigSharedGuest picks the next of c's guests for a new Group, round-robin,
// replacing one that holds a Kind the Core has since redefined.
func zigSharedGuest(c *Core) *zigShared {
	c.mu.Lock()
	pool, _ := c.zigGuests.(*zigGuestPool)
	if pool == nil {
		pool = &zigGuestPool{guests: make([]*zigShared, max(1, runtime.GOMAXPROCS(0)))}
		c.zigGuests = pool
	}
	kinds := maps.Clone(c.objectKinds)
	c.mu.Unlock()
	pool.mu.Lock()
	defer pool.mu.Unlock()
	i := pool.next
	pool.next = (i + 1) % len(pool.guests)
	if pool.guests[i] == nil || pool.guests[i].reg.conflicts(kinds) {
		pool.guests[i] = newZigShared()
	}
	return pool.guests[i]
}

func newZigSharedGroup(g *Group) *zigGroup {
	b := &zigGroup{group: g, inlineWake: make(chan struct{}, 1), pending: map[DeliveryID]*Pending{}, decisions: map[string]*Deciding{}, runs: map[RunID]DeliveryID{}, coordinators: map[*SegmentLifecycle]string{}, effectDetails: map[string]string{}, calls: map[CallID]context.CancelFunc{}, failureDetails: map[CallID]string{}}
	if err := b.join(zigSharedGuest(g.core)); err != nil {
		panic(err)
	}
	return b
}

// join reserves a handle on s. The first Group frame creates guest state.
func (b *zigGroup) join(s *zigShared) error {
	s.mu.Lock()
	s.groups++
	b.handle = fmt.Sprintf("g%d", s.groups)
	s.mu.Unlock()
	b.shared, b.reactor, b.reg = s, s.reactor, s.reg
	s.hello.Do(func() { s.helloErr = b.checkHello() })
	if s.helloErr != nil {
		return s.helloErr
	}
	b.created = false
	b.untouched = true
	return nil
}

// groupFields preserves the Message Layer's exact unsigned seed representation.
func (b *zigGroup) groupFields() map[string]any {
	var seed any = b.group.options.Seed
	if b.group.options.Seed >= 1<<53 {
		seed = strconv.FormatUint(b.group.options.Seed, 10)
	}
	return map[string]any{"name": b.group.Name(), "trace": b.group.options.Trace != nil, "seed": seed}
}

// createdGroup starts cleanup only once guest state may exist. An untouched
// Group consumes neither guest state nor a drop-group export.
func (b *zigGroup) createdGroup() {
	b.created = true
	b.dropping = runtime.AddCleanup(b.group, dropZigGroup, zigDrop{b.shared, b.handle})
}

// moveForKind moves an untouched Group to one of its Core's guests where
// kind's name is free, or a new one, and reports whether it moved.
func (b *zigGroup) moveForKind(kind *ObjectKind) bool {
	b.frameMu.Lock()
	movable := b.shared != nil && b.untouched && !b.exporting && !b.paused
	b.frameMu.Unlock()
	if !movable {
		return false
	}
	c := b.group.core
	c.mu.Lock()
	pool := c.zigGuests.(*zigGuestPool)
	c.mu.Unlock()
	pool.mu.Lock()
	var to *zigShared
	for _, s := range pool.guests {
		if s != nil && s != b.shared && s.reg.kindFree(kind) {
			to = s
			break
		}
	}
	if to == nil {
		to = newZigShared()
		pool.guests[pool.next] = to
		pool.next = (pool.next + 1) % len(pool.guests)
	}
	pool.mu.Unlock()
	if b.created {
		b.dropping.Stop()
		dropZigGroup(zigDrop{b.shared, b.handle})
	}
	if err := b.join(to); err != nil {
		panic(err)
	}
	return true
}

// shareFrame sends one frame to b's guest, which b holds for that frame.
func (b *zigGroup) shareFrame(data []byte) ([]byte, error) {
	s := b.shared
	s.mu.Lock()
	defer s.mu.Unlock()
	s.owner = b
	defer func() { s.owner = nil }()
	return s.reactor.Frame(context.Background(), data)
}

type zigDrop struct {
	shared *zigShared
	handle string
}

// dropZigGroup frees a collected Group's state in its guest. A Group
// collected mid-exchange stays, since the guest refuses to drop it.
func dropZigGroup(d zigDrop) {
	data, _ := zigJSON(nil, map[string]any{"m": "drop-group", "ref": 0, "group": d.handle})
	d.shared.mu.Lock()
	defer d.shared.mu.Unlock()
	d.shared.reactor.Frame(context.Background(), data)
}
