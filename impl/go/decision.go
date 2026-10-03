package northtalk

import (
	"context"
	"sync"

	coretrace "github.com/odogono/odgn-talk/impl/go/internal/trace"
	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
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
	mu     sync.Mutex
	done   chan struct{}
	sealed bool
	result *Decided
	stop   func() bool
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
func (d *Deciding) finish() { close(d.done) }

func (s *Script) Decide(ctx context.Context, m Message) (DeliveryID, *Deciding, error) {
	return s.group.decide(s, ctx, m)
}
func (g *Group) Decide(ctx context.Context, to *Object, m Message) (DeliveryID, *Deciding, error) {
	return g.decide(g.receiver(to), ctx, m)
}
func (g *Group) decide(s *Script, ctx context.Context, m Message) (DeliveryID, *Deciding, error) {
	d := &Deciding{done: make(chan struct{})}
	id, _, err := g.enqueue(s, m, ctx, false, d)
	if err != nil {
		return "", nil, err
	}
	return id, d, nil
}
func (x *execution) openVerdict() bool {
	return x.deciding && x.delivery.decision != nil && !x.delivery.decision.isSealed()
}
func (g *Group) recordDecided(d *Decided) {
	fields := map[string]string{"verdict": []string{"allowed", "vetoed", "undecided"}[d.Verdict]}
	if len(d.Vetoes) > 0 {
		var entries []corevalue.Value
		for _, v := range d.Vetoes {
			m, _ := corevalue.NewMap([]corevalue.Pair{{Key: "script", Val: mustText(v.Script)}, {Key: "run", Val: mustText(string(v.Run))}, {Key: "reason", Val: v.Reason.inner}})
			entries = append(entries, m)
		}
		fields["vetoes"] = coretrace.Display(corevalue.NewList(entries))
	}
	if len(d.Undecided) > 0 {
		var entries []corevalue.Value
		for _, v := range d.Undecided {
			pairs := []corevalue.Pair{{Key: "script", Val: mustText(v.Script)}}
			if v.Run != "" {
				pairs = append(pairs, corevalue.Pair{Key: "run", Val: mustText(string(v.Run))})
			}
			pairs = append(pairs, corevalue.Pair{Key: "outcome", Val: mustText([]string{"completed", "errored", "limit fault", "cancelled", "unhandled", "dropped", "effect failed"}[v.Outcome])})
			m, _ := corevalue.NewMap(pairs)
			entries = append(entries, m)
		}
		fields["undecided"] = coretrace.Display(corevalue.NewList(entries))
	}
	g.record("decided", false, []string{string(d.Delivery)}, fields)
}
