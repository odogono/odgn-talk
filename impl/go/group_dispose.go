package northtalk

import (
	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
	"strings"
)

// An owner disposal stops already-started Runs. Object-addressed mailbox
// messages still follow their current paths, while direct messages are dropped.
func (g *Group) disposeOwner(s *Script, reports *[]Report, settlements *[]func(), seal func(delivery, RunID, Verdict, Value, Outcome)) {
	g.stopScript(s, "owner disposed", reports, settlements, seal)
}

func (g *Group) stopScript(s *Script, reason string, reports *[]Report, settlements *[]func(), seal func(delivery, RunID, Verdict, Value, Outcome)) {
	if g.effectUnknown && !s.stopped {
		// After fatal uncertainty, only the Group stop may publish termination.
		// Later queued controls cannot change its reason or report order.
		return
	}
	g.terminateScript(s, reason, reports, settlements, seal)
}

func (g *Group) terminateScript(s *Script, reason string, reports *[]Report, settlements *[]func(), seal func(delivery, RunID, Verdict, Value, Outcome)) {
	wasUnknown := g.effectUnknown
	g.mu.Lock()
	already := s.stopped
	previousReason := s.stopReason
	if !already {
		s.stopReason = reason
	}
	s.stopped = true
	reason = s.stopReason
	g.mu.Unlock()
	if already && len(s.runs) == 0 && len(s.queue) == 0 {
		return
	}
	stop := &Stop{Script: s.name, Reason: reason}
	runs, queue := s.runs, s.queue
	active, gone := s.active, s.state.Gone
	if s.active != nil {
		s.state.Variables = s.active.run.Base
	}
	s.runs, s.queue, s.active = nil, nil, nil
	s.state.Gone = true
	settle := func(d delivery, run RunID) {
		g.reply(d.reply, corevalue.Value{}, "stopped", corevalue.Value{})
		if d.pending != nil {
			*settlements = append(*settlements, func() { d.pending.settle(Nothing, sendFailure("stopped", nil)) })
		}
		seal(d, run, Undecided, Nothing, Cancelled)
	}
	for _, x := range runs {
		g.abandonScopes(s, x, reports)
		g.rollbackParticipant(s, x, reports)
		stop.DiscardedRuns = append(stop.DiscardedRuns, x.id)
		if x.waitCall != "" {
			stop.PendingCalls = append(stop.PendingCalls, x.waitCall)
		}
		if j := x.run.Join; j != nil && !j.Ready {
			for _, m := range j.Members {
				if m.Reply == nil {
					stop.PendingCalls = append(stop.PendingCalls, CallID(m.ID))
				}
			}
		}
		for _, id := range x.run.Abandons {
			stop.PendingCalls = append(stop.PendingCalls, CallID(id))
		}
		if x.abandonCall != "" {
			stop.PendingCalls = append(stop.PendingCalls, x.abandonCall)
		}
		g.discardOperationCalls(x)
	}
	if !wasUnknown && g.effectUnknown {
		// Cleanup discovered fatal uncertainty before publishing this Stop.
		// Keep the discarded work available to the Group stop so its reports
		// follow Script load order; cleared participants are never retried.
		s.runs, s.queue, s.active = runs, queue, active
		s.state.Gone = gone
		g.mu.Lock()
		s.stopped, s.stopReason = already, previousReason
		g.mu.Unlock()
		// The Pump's caller publishes the Group stop after ending any current
		// Stretch. No further Script execution is allowed once uncertainty lands.
		return
	}
	for _, x := range runs {
		g.accountEnd(x, "discarded", "stop", reports)
	}
	dropped := []delivery{}
	for _, item := range queue {
		if item.run != nil {
			continue
		}
		d := item.delivery
		if d.path {
			if moved, changed := g.moveDelivery(d); changed {
				if moved.script == nil {
					g.unrouted = append(g.unrouted, moved)
				}
				continue
			}
		}
		g.release(s)
		if d.id != "" {
			stop.DroppedMessages = append(stop.DroppedMessages, d.id)
		}
		g.accountDrop(d)
		dropped = append(dropped, d)
	}
	fields := map[string]string{"reason": corevalue.DisplayText(stop.Reason)}
	format := func(xs []string) string { return "[" + strings.Join(xs, ", ") + "]" }
	if len(stop.DiscardedRuns) > 0 {
		xs := []string{}
		for _, id := range stop.DiscardedRuns {
			xs = append(xs, string(id))
		}
		fields["discarded"] = format(xs)
	}
	if len(stop.DroppedMessages) > 0 {
		xs := []string{}
		for _, id := range stop.DroppedMessages {
			xs = append(xs, string(id))
		}
		fields["dropped"] = format(xs)
	}
	if len(stop.PendingCalls) > 0 {
		xs := []string{}
		for _, id := range stop.PendingCalls {
			xs = append(xs, string(id))
		}
		fields["abandoned"] = format(xs)
	}
	*reports = append(*reports, stop)
	g.record("stopped", false, []string{s.name}, fields)
	for _, x := range runs {
		settle(x.delivery, x.id)
	}
	for _, d := range dropped {
		settle(d, "")
	}
}
