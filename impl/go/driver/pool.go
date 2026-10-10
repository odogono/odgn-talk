package driver

import (
	"errors"
	"runtime"
	"slices"
	"sync"
	"time"

	talk "github.com/odogono/odgn-talk/impl/go"
)

// Clock gives a Pool its readings and its per-Group deadline timers. RealClock
// reads the wall clock; ManualClock lets a Host or test move time by hand.
// AfterFunc must not call f before it returns.
type Clock interface {
	Now() time.Time
	AfterFunc(d time.Duration, f func()) Timer
}

// Timer is a pending AfterFunc call.
type Timer interface{ Stop() bool }

type realClock struct{}

func (realClock) Now() time.Time                            { return time.Now() }
func (realClock) AfterFunc(d time.Duration, f func()) Timer { return time.AfterFunc(d, f) }

// RealClock reads the Host's wall clock.
func RealClock() Clock { return realClock{} }

// PoolOptions configures a Pool.
type PoolOptions struct {
	Workers int   // goroutines pumping Groups; 0 means GOMAXPROCS
	Clock   Clock // nil means RealClock
	// Pump is passed to every Pump. A FuelSlice sends a Group that still has
	// work to the back of the run queue, so one tenant can't hold a worker.
	Pump talk.PumpOptions
	// OnPump receives every Pump's result on the worker that made it, while
	// the Group is still held, so it may make worker calls such as Reload
	// after a Rewound Pump. It must not block for long.
	OnPump func(m *Member, r talk.PumpResult, err error)
}

// Pool pumps many Groups on a fixed set of workers. Each Group has one run
// queue entry at most and one deadline timer, and is pumped by one worker at
// a time, so its worker calls never overlap (spec chapter 9, Threads and the
// input queue).
type Pool struct {
	options PoolOptions
	mu      sync.Mutex
	cond    *sync.Cond
	queue   []*Member
	busy    int // Members queued or being pumped
	closed  bool
	members map[*Member]struct{}
	workers sync.WaitGroup
}

// Member is one Group in a Pool.
type Member struct {
	pool  *Pool
	group *talk.Group
	work  sync.Mutex // held for each Pump and Do, so worker calls never overlap
	// Guarded by pool.mu.
	queued  bool
	running bool
	again   bool // made ready while being pumped
	removed bool
	timer   Timer
}

// ErrClosed is returned for work offered to a closed Pool or a removed Member.
var ErrClosed = errors.New("driver: pool closed")

// NewPool starts a Pool's workers.
func NewPool(o PoolOptions) *Pool {
	if o.Workers <= 0 {
		o.Workers = runtime.GOMAXPROCS(0)
	}
	if o.Clock == nil {
		o.Clock = RealClock()
	}
	p := &Pool{options: o, members: map[*Member]struct{}{}}
	p.cond = sync.NewCond(&p.mu)
	for range o.Workers {
		p.workers.Add(1)
		go p.work()
	}
	return p
}

// NewGroup makes a Group whose OnReady puts it on this Pool's run queue. Any
// OnReady in o is replaced.
func (p *Pool) NewGroup(core *talk.Core, o talk.GroupOptions) *Member {
	m := &Member{pool: p}
	o.OnReady = m.Ready
	m.group = core.NewGroup(o)
	p.mu.Lock()
	p.members[m] = struct{}{}
	p.mu.Unlock()
	return m
}

// Group is the Member's Group. Queued calls on it are safe from any goroutine;
// make worker calls through Do.
func (m *Member) Group() *talk.Group { return m.group }

// Do runs f with the Group held, so its worker calls (Load, Reload, Extend,
// Inspect, Counters, Save and the rest) never overlap a Pump. Queued inputs f
// makes reach the run queue through OnReady as usual.
func (m *Member) Do(f func(g *talk.Group) error) error {
	m.pool.mu.Lock()
	removed := m.removed
	m.pool.mu.Unlock()
	if removed {
		return ErrClosed
	}
	m.work.Lock()
	defer m.work.Unlock()
	return f(m.group)
}

// Ready puts the Group on the run queue, once. It is the Group's OnReady.
func (m *Member) Ready() {
	p := m.pool
	p.mu.Lock()
	defer p.mu.Unlock()
	p.ready(m)
}

func (p *Pool) ready(m *Member) {
	switch {
	case p.closed || m.removed:
	case m.running:
		m.again = true
	case !m.queued:
		m.queued = true
		p.busy++
		p.queue = append(p.queue, m)
		p.cond.Broadcast()
	}
}

// Remove takes the Member out of the Pool: it is never pumped again, and its
// timer is stopped. A Pump already running finishes first.
func (m *Member) Remove() {
	p := m.pool
	p.mu.Lock()
	m.removed = true
	if m.timer != nil {
		m.timer.Stop()
		m.timer = nil
	}
	delete(p.members, m)
	p.mu.Unlock()
	m.work.Lock()
	m.work.Unlock()
}

// Wait blocks until no Group is queued or being pumped. Groups waiting only
// on a deadline count as settled; their timers stay armed.
func (p *Pool) Wait() {
	p.mu.Lock()
	defer p.mu.Unlock()
	for p.busy > 0 && !p.closed {
		p.cond.Wait()
	}
}

// Close stops the workers after any running Pumps finish, and stops every
// timer. Queued Groups are left unpumped.
func (p *Pool) Close() {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return
	}
	p.closed = true
	for m := range p.members {
		if m.timer != nil {
			m.timer.Stop()
			m.timer = nil
		}
	}
	p.queue = nil
	p.cond.Broadcast()
	p.mu.Unlock()
	p.workers.Wait()
}

func (p *Pool) work() {
	defer p.workers.Done()
	for {
		p.mu.Lock()
		for len(p.queue) == 0 && !p.closed {
			p.cond.Wait()
		}
		if p.closed {
			p.mu.Unlock()
			return
		}
		m := p.queue[0]
		p.queue = p.queue[1:]
		m.queued = false
		if m.removed {
			p.settle()
			p.mu.Unlock()
			continue
		}
		m.running = true
		if m.timer != nil {
			m.timer.Stop()
			m.timer = nil
		}
		p.mu.Unlock()
		p.pump(m)
	}
}

func (p *Pool) pump(m *Member) {
	m.work.Lock()
	now := p.options.Clock.Now()
	r, err := m.group.Pump(now, p.options.Pump)
	if p.options.OnPump != nil {
		p.options.OnPump(m, r, err)
	}
	m.work.Unlock()
	p.mu.Lock()
	defer p.mu.Unlock()
	m.running = false
	again := m.again || (err == nil && (r.State == talk.Sliced || r.State == talk.Rewound))
	m.again = false
	if err == nil && !r.NextDeadline.IsZero() && !m.removed && !p.closed {
		m.timer = p.options.Clock.AfterFunc(r.NextDeadline.Sub(now), m.Ready)
	}
	if again {
		// Requeued before settling, so Wait never sees a gap.
		p.ready(m)
	}
	p.settle()
}

func (p *Pool) settle() {
	p.busy--
	if p.busy == 0 {
		p.cond.Broadcast()
	}
}

// ManualClock is a Clock that moves only when told to, firing due timers in
// deadline order. It suits replayable Hosts and tests.
type ManualClock struct {
	mu     sync.Mutex
	now    time.Time
	timers []*manualTimer
}

type manualTimer struct {
	clock *ManualClock
	at    time.Time
	f     func()
	done  bool
}

// NewManualClock starts a ManualClock at now.
func NewManualClock(now time.Time) *ManualClock { return &ManualClock{now: now} }

func (c *ManualClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

// AfterFunc never calls f itself, even when d isn't positive: the next
// Advance does, Advance(0) included.
func (c *ManualClock) AfterFunc(d time.Duration, f func()) Timer {
	c.mu.Lock()
	defer c.mu.Unlock()
	t := &manualTimer{clock: c, at: c.now.Add(d), f: f}
	c.timers = append(c.timers, t)
	return t
}

// Advance moves the clock forward by d, then fires every timer now due,
// earliest first. A Pool pumps those Groups later, reading the clock then, so
// a Host that needs each deadline's own reading advances to it and waits.
func (c *ManualClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	var due []*manualTimer
	live := c.timers[:0]
	for _, t := range c.timers {
		switch {
		case t.done:
		case !t.at.After(c.now):
			t.done = true
			due = append(due, t)
		default:
			live = append(live, t)
		}
	}
	c.timers = live
	c.mu.Unlock()
	slices.SortStableFunc(due, func(a, b *manualTimer) int { return a.at.Compare(b.at) })
	for _, t := range due {
		t.f()
	}
}

func (t *manualTimer) Stop() bool {
	t.clock.mu.Lock()
	defer t.clock.mu.Unlock()
	if t.done {
		return false
	}
	t.done = true
	return true
}
