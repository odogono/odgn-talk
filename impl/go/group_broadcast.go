package northtalk

import (
	"context"
	"fmt"
	"strings"
)

// Broadcast queues a message for the Scripts that want it at the next drain.
func (g *Group) Broadcast(m Message) (BroadcastID, error) {
	id, _, err := g.admit(nil, m, nil, false, nil, delivery{kind: "broadcast"})
	return BroadcastID(id), err
}

func (g *Group) DecideBroadcast(ctx context.Context, m Message) (BroadcastID, *Deciding, error) {
	d := &Deciding{done: make(chan struct{})}
	id, _, err := g.admit(nil, m, ctx, false, d, delivery{kind: "broadcast"})
	if err != nil {
		return "", nil, err
	}
	return BroadcastID(id), d, nil
}

type broadcastDecision struct {
	id        BroadcastID
	future    *Deciding
	remaining int
	results   []*Decided
}

func (b *broadcastDecision) collect(index int, report *Decided) *Decided {
	b.results[index] = report
	b.remaining--
	if b.remaining != 0 {
		return nil
	}
	combined := &Decided{Broadcast: b.id, Verdict: Allowed}
	for _, r := range b.results {
		combined.Vetoes = append(combined.Vetoes, r.Vetoes...)
		combined.Undecided = append(combined.Undecided, r.Undecided...)
	}
	if len(combined.Undecided) > 0 {
		combined.Verdict = Undecided
	}
	if len(combined.Vetoes) > 0 {
		combined.Verdict = Vetoed
	}
	b.future.seal(combined)
	return combined
}

func (s *Script) wantsBroadcast(name string, cancelled map[*execution]bool) bool {
	if s.hasHandler(name) {
		return true
	}
	for _, x := range s.runs {
		if !cancelled[x] && x.run.EventWait != nil {
			for _, branch := range x.run.EventWait.Branches {
				if !branch.Entry.After && branch.Entry.Message == name {
					return true
				}
			}
		}
	}
	return false
}

// Select recipients before formatting Host inputs. Account for earlier queued
// disposals and cancellation, but do not observe messages or execute any Run.
func (g *Group) prepareBroadcasts(inputs []delivery) []delivery {
	hasBroadcast := false
	for _, d := range inputs {
		if d.kind == "broadcast" || d.kind == "decide-broadcast" {
			hasBroadcast = true
			break
		}
	}
	if !hasBroadcast {
		return inputs
	}
	stopped := map[*Script]bool{}
	cancelled := map[*execution]bool{}
	for i := range inputs {
		d := &inputs[i]
		if d.cancel != "" && d.decision != nil && d.decision.isSealed() {
			continue
		}
		if d.kind == "dispose" {
			stopped[d.object.owner] = true
		}
		if d.cancel != "" || d.kind == "cancel-run" {
			for _, s := range g.scripts {
				for _, x := range s.runs {
					if d.kind == "cancel-run" && s == d.script && string(x.id) == d.fields["run"] || d.cancel != "" && x.delivery.id == d.cancel {
						cancelled[x] = true
					}
				}
			}
		}
		if d.kind != "broadcast" && d.kind != "decide-broadcast" {
			continue
		}
		var b *broadcastDecision
		if d.decision != nil {
			b = &broadcastDecision{id: d.broadcast, future: d.decision}
		}
		var recipients []string
		g.mu.Lock()
		for _, s := range g.scripts {
			if s.stopped || stopped[s] || !s.wantsBroadcast(d.message.Name, cancelled) {
				continue
			}
			g.nextDelivery++
			child := delivery{id: DeliveryID(fmt.Sprintf("d%d", g.nextDelivery)), broadcast: d.broadcast, script: s, target: s.owner, message: d.message}
			if b != nil {
				child.decision = &Deciding{done: make(chan struct{}), broadcast: b, recipient: len(d.children)}
				b.results = append(b.results, nil)
				b.remaining++
			}
			s.reserved++
			d.children = append(d.children, child)
			recipients = append(recipients, s.name+":"+string(child.id))
		}
		g.mu.Unlock()
		if len(recipients) > 0 {
			d.fields["recipients"] = "[" + strings.Join(recipients, ", ") + "]"
		}
	}
	return inputs
}
