package driver

import (
	"context"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	talk "github.com/odogono/odgn-talk/impl/go"
)

var poolStart = time.Date(2026, 10, 10, 9, 0, 0, 0, time.UTC)

type traceLines struct {
	mu    sync.Mutex
	lines []string
}

func (t *traceLines) Record(line string) { t.mu.Lock(); t.lines = append(t.lines, line); t.mu.Unlock() }
func (t *traceLines) text() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return strings.Join(t.lines, "\n")
}

func load(t *testing.T, m *Member, source string, grants map[string]*talk.Grant) *talk.Script {
	t.Helper()
	var s *talk.Script
	if err := m.Do(func(g *talk.Group) (err error) {
		s, err = g.Load(talk.LoadOptions{Name: "s", Source: source, Grants: grants})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return s
}

func result(t *testing.T, p *talk.Pending) talk.Value {
	t.Helper()
	select {
	case <-p.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("Request never settled")
	}
	v, failure := p.Result()
	if failure != nil {
		t.Fatal(failure)
	}
	return v
}

// Two Groups are inside a Pump at once: each one's Operation waits for the
// other's to start.
func TestPoolPumpsGroupsInParallel(t *testing.T) {
	core := talk.New()
	var arrived sync.WaitGroup
	arrived.Add(2)
	def, err := core.DefineCapability("meet", talk.Operation{Name: "meet", Mode: talk.Immediate, Result: talk.NumberShape, Do: func(c *talk.Call, args []talk.Value) (talk.Value, error) {
		arrived.Done()
		done := make(chan struct{})
		go func() { arrived.Wait(); close(done) }()
		select {
		case <-done:
			return talk.Int(1), nil
		case <-time.After(5 * time.Second):
			return talk.Nothing, &talk.ScriptError{Code: "alone"}
		}
	}})
	if err != nil {
		t.Fatal(err)
	}
	p := NewPool(PoolOptions{Workers: 2, Clock: NewManualClock(poolStart)})
	defer p.Close()
	var pending []*talk.Pending
	for range 2 {
		m := p.NewGroup(core, talk.GroupOptions{})
		s := load(t, m, "on go\n  ask meet to meet\n  return it\nend go", map[string]*talk.Grant{"meet": def.GrantAll(nil)})
		_, f, err := s.Request(context.Background(), talk.Message{Name: "go"})
		if err != nil {
			t.Fatal(err)
		}
		pending = append(pending, f)
	}
	for _, f := range pending {
		if v := result(t, f); !v.Equal(talk.Int(1)) {
			t.Fatal(v)
		}
	}
}

// A Group waiting on a deadline is pumped by its timer, with the Clock's
// reading at the deadline.
func TestPoolTimerPumpsAtDeadline(t *testing.T) {
	clock := NewManualClock(poolStart)
	p := NewPool(PoolOptions{Workers: 1, Clock: clock})
	defer p.Close()
	var trace traceLines
	m := p.NewGroup(talk.New(), talk.GroupOptions{Trace: &trace})
	s := load(t, m, "on go\n  wait 5 s\n  return 7\nend go", nil)
	_, f, err := s.Request(context.Background(), talk.Message{Name: "go"})
	if err != nil {
		t.Fatal(err)
	}
	p.Wait()
	select {
	case <-f.Done():
		t.Fatal("settled before its deadline")
	default:
	}
	clock.Advance(4 * time.Second)
	p.Wait()
	select {
	case <-f.Done():
		t.Fatal("settled before its deadline")
	default:
	}
	clock.Advance(time.Second)
	if v := result(t, f); !v.Equal(talk.Int(7)) {
		t.Fatal(v)
	}
	p.Wait()
	if got := trace.text(); !strings.Contains(got, "> pump clock=2026-10-10T09:00:05Z") || strings.Contains(got, "> pump clock=2026-10-10T09:00:04Z") {
		t.Fatal(got)
	}
}

// With the wall clock, a deadline's timer pumps the Group unprompted.
func TestPoolRealClockTimer(t *testing.T) {
	p := NewPool(PoolOptions{Workers: 1})
	defer p.Close()
	m := p.NewGroup(talk.New(), talk.GroupOptions{})
	s := load(t, m, "on go\n  wait 50 ms\n  return 7\nend go", nil)
	start := time.Now()
	_, f, err := s.Request(context.Background(), talk.Message{Name: "go"})
	if err != nil {
		t.Fatal(err)
	}
	if v := result(t, f); !v.Equal(talk.Int(7)) || time.Since(start) < 50*time.Millisecond {
		t.Fatal(v, time.Since(start))
	}
}

// A Fuel Slice sends a busy Group to the back of the run queue, so another
// Group's work isn't held up behind it.
func TestPoolSlicedGroupYields(t *testing.T) {
	core := talk.New()
	var mu sync.Mutex
	var order []string
	p := NewPool(PoolOptions{Workers: 1, Clock: NewManualClock(poolStart), Pump: talk.PumpOptions{FuelSlice: 200}, OnPump: func(m *Member, r talk.PumpResult, err error) {
		if err != nil {
			t.Error(err)
		}
		mu.Lock()
		order = append(order, m.Group().Name())
		mu.Unlock()
	}})
	defer p.Close()
	busy := p.NewGroup(core, talk.GroupOptions{Name: "busy"})
	quick := p.NewGroup(core, talk.GroupOptions{Name: "quick"})
	bs := load(t, busy, "on go\n  put 0 into n\n  repeat 200 times\n    add 1 to n\n  end repeat\n  return n\nend go", nil)
	qs := load(t, quick, "on go\n  return 1\nend go", nil)
	// Hold the only worker until both Groups are queued.
	held, hold := make(chan struct{}), make(chan struct{})
	go busy.Do(func(*talk.Group) error { close(held); <-hold; return nil })
	<-held
	_, bf, err := bs.Request(context.Background(), talk.Message{Name: "go"})
	if err != nil {
		t.Fatal(err)
	}
	_, qf, err := qs.Request(context.Background(), talk.Message{Name: "go"})
	if err != nil {
		t.Fatal(err)
	}
	close(hold)
	result(t, qf)
	if v := result(t, bf); !v.Equal(talk.Int(200)) {
		t.Fatal(v)
	}
	p.Wait()
	mu.Lock()
	defer mu.Unlock()
	q := slices.Index(order, "quick")
	if q != 1 || len(order) < 3 || order[0] != "busy" || order[len(order)-1] != "busy" {
		t.Fatal(order)
	}
}

// A queued input made while the Group is being pumped gets another Pump.
func TestPoolReadyDuringPumpPumpsAgain(t *testing.T) {
	core := talk.New()
	var s *talk.Script
	var once sync.Once
	def, err := core.DefineCapability("again", talk.Operation{Name: "poke", Mode: talk.FireAndForget, Fire: func(c *talk.Call, args []talk.Value) error {
		once.Do(func() { _, _ = s.Deliver(talk.Message{Name: "second"}) })
		return nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	p := NewPool(PoolOptions{Workers: 1, Clock: NewManualClock(poolStart)})
	defer p.Close()
	m := p.NewGroup(core, talk.GroupOptions{})
	s = load(t, m, "script variable seen = 0\non first\n  tell again to poke\nend first\non second\n  add 1 to seen\nend second", map[string]*talk.Grant{"again": def.GrantAll(nil)})
	if _, err := s.Deliver(talk.Message{Name: "first"}); err != nil {
		t.Fatal(err)
	}
	p.Wait()
	var vars []talk.Pair
	_ = m.Do(func(g *talk.Group) error { vars = g.Inspect().Scripts[0].Vars; return nil })
	if len(vars) != 1 || !vars[0].Val.Equal(talk.Int(1)) {
		t.Fatal(vars)
	}
}

// A removed Member is never pumped, and a closed Pool ignores readiness.
func TestPoolRemoveAndClose(t *testing.T) {
	clock := NewManualClock(poolStart)
	p := NewPool(PoolOptions{Workers: 1, Clock: clock})
	m := p.NewGroup(talk.New(), talk.GroupOptions{})
	s := load(t, m, "script variable n = 0\non go\n  wait 1 s\n  add 1 to n\nend go", nil)
	if _, err := s.Deliver(talk.Message{Name: "go"}); err != nil {
		t.Fatal(err)
	}
	p.Wait()
	m.Remove()
	clock.Advance(time.Second)
	p.Wait()
	if err := m.Do(func(*talk.Group) error { return nil }); err != ErrClosed {
		t.Fatal(err)
	}
	if v := m.Group().Inspect().Scripts[0].Vars[0].Val; !v.Equal(talk.Int(0)) {
		t.Fatal(v)
	}
	p.Close()
	p.Close()
	m.Ready()
	p.Wait()
}

func TestManualClockFiresDueTimersInOrder(t *testing.T) {
	c := NewManualClock(poolStart)
	var fired []string
	c.AfterFunc(2*time.Second, func() { fired = append(fired, "b") })
	c.AfterFunc(time.Second, func() { fired = append(fired, "a") })
	stopped := c.AfterFunc(time.Second, func() { fired = append(fired, "x") })
	if !stopped.Stop() || stopped.Stop() {
		t.Fatal("Stop")
	}
	c.AfterFunc(0, func() { fired = append(fired, "0") })
	if len(fired) != 0 {
		t.Fatal(fired)
	}
	c.Advance(1500 * time.Millisecond)
	if strings.Join(fired, "") != "0a" {
		t.Fatal(fired)
	}
	c.Advance(time.Hour)
	if strings.Join(fired, "") != "0ab" || !c.Now().Equal(poolStart.Add(time.Hour+1500*time.Millisecond)) {
		t.Fatal(fired, c.Now())
	}
}
