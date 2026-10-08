package northtalk

import (
	"slices"

	"github.com/odogono/odgn-talk/impl/go/internal/machine"
)

// RewindRun queues a Rewind (ADR 0068). It lands as CancelRun does: at a Host
// crossing or the Pump's end.
func (s *Script) RewindRun(id RunID) {
	g := s.group
	g.mu.Lock()
	g.controlsQueued = true
	g.inputs = append(g.inputs, delivery{kind: "rewind-run", script: s, fields: map[string]string{"run": string(id)}})
	ready := g.options.OnReady
	g.mu.Unlock()
	if ready != nil {
		ready()
	}
}

// rewindable reports whether a Run is still in the Segment it started in.
func (x *execution) rewindable() bool {
	r := x.run
	if x.suspendedOnce || r.Cancelling || x.stopReason != nil || r.Join != nil || x.waitCall != "" {
		return false
	}
	switch r.Status {
	case machine.Running, machine.Preempted, machine.Parked, machine.Dispatching:
		return true
	}
	return false
}

// applyRewindRun lands a Rewind. One on the Run executing at this crossing
// halts it, and the turn ends it; any other is rewound here.
func (g *Group) applyRewindRun(d delivery, current *execution, reports *[]Report) {
	s := d.script
	var x *execution
	for _, run := range s.runs {
		if string(run.id) == d.fields["run"] {
			x = run
			break
		}
	}
	if x == nil || s.stopped || g.effectUnknown || !x.rewindable() {
		g.record("note", false, []string{d.fields["run"]}, map[string]string{"kind": "not-rewindable"})
		return
	}
	g.rewound = true
	if x == current {
		x.rewound = true
		x.run.Status = machine.Stopped
		return
	}
	g.rewindExecution(s, x, reports)
}

// rewindExecution rolls back a Run's first Segment, ends it and puts its
// message back at the head of the mailbox (ADR 0068).
func (g *Group) rewindExecution(s *Script, x *execution, reports *[]Report) {
	// A parked Run is between Segments: other Runs may have committed since.
	if !x.parked {
		s.state.Variables = slices.Clone(x.run.Base)
	}
	g.abandonScopes(s, x, reports)
	g.rollbackParticipant(s, x, reports)
	g.writeAbandon(x)
	g.discardOperationCalls(x)
	g.accountEnd(x, "discarded", "rewind", reports)
	if s.active == x {
		s.active = nil
	}
	s.queue = slices.DeleteFunc(s.queue, func(item workItem) bool { return item.run == x })
	for j, live := range s.runs {
		if live == x {
			s.runs = slices.Delete(s.runs, j, j+1)
			break
		}
	}
	g.mu.Lock()
	s.reserved++
	g.mu.Unlock()
	s.queue = slices.Insert(s.queue, 0, workItem{delivery: x.delivery})
}
