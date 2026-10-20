package northtalk

import (
	"context"
	"sync"
)

type Verdict int

const (
	Allowed Verdict = iota
	Vetoed
	Undecided
)

type Decided struct {
	Delivery  DeliveryID
	Broadcast BroadcastID
	Verdict   Verdict
	Vetoes    []Veto
	Undecided []UndecidedBy
}

type Veto struct {
	Script string
	Run    RunID
	Reason Value
}
type UndecidedBy struct {
	Script  string
	Run     RunID
	Outcome Outcome
}

func (d *Decided) isReport() {}

// Deciding settles when the Verdict is sealed, independently of the Run's end.
type Deciding struct {
	mu        sync.Mutex
	done      chan struct{}
	sealed    bool
	result    *Decided
	stop      func() bool
	broadcast *broadcastDecision
}

func (d *Deciding) Done() <-chan struct{} { return d.done }
func (d *Deciding) Decided() *Decided {
	d.mu.Lock()
	defer d.mu.Unlock()
	select {
	case <-d.done:
		return cloneDecided(d.result)
	default:
		return nil
	}
}
func cloneDecided(d *Decided) *Decided {
	if d == nil {
		return nil
	}
	copy := *d
	copy.Vetoes = append([]Veto(nil), d.Vetoes...)
	copy.Undecided = append([]UndecidedBy(nil), d.Undecided...)
	return &copy
}
func (d *Deciding) isSealed() bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.sealed
}
func (d *Deciding) seal(report *Decided) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.sealed {
		return false
	}
	d.sealed = true
	d.result = cloneDecided(report)
	if d.stop != nil {
		d.stop()
	}
	return true
}
func (d *Deciding) finish() {
	if d.broadcast != nil {
		close(d.broadcast.future.done)
	} else {
		close(d.done)
	}
}

func (s *Script) Decide(ctx context.Context, m Message) (DeliveryID, *Deciding, error) {
	return s.group.decide(s, ctx, m)
}
func (g *Group) Decide(ctx context.Context, to *Object, m Message) (DeliveryID, *Deciding, error) {
	return g.decide(nil, ctx, m, to)
}
func (g *Group) decide(s *Script, ctx context.Context, m Message, objects ...*Object) (DeliveryID, *Deciding, error) {
	d := &Deciding{done: make(chan struct{})}
	id, _, err := g.enqueue(s, m, ctx, false, d, objects...)
	if err != nil {
		return "", nil, err
	}
	return id, d, nil
}
