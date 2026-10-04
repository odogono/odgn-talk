package northtalk

// CancelRun queues cleanup at an instruction boundary or the Pump's end.
func (s *Script) CancelRun(id RunID) {
	g := s.group
	g.mu.Lock()
	g.cancelRunsQueued = true
	g.inputs = append(g.inputs, delivery{kind: "cancel-run", script: s, fields: map[string]string{"run": string(id)}})
	ready := g.options.OnReady
	g.mu.Unlock()
	if ready != nil {
		ready()
	}
}
func (g *Group) applyCancelRun(d delivery) {
	for _, x := range d.script.runs {
		if string(x.id) == d.fields["run"] {
			g.cancelExecution(d.script, x)
			return
		}
	}
}

// Only cancellation may be taken from inputs while a Pump is running. All
// ordinary settlements and Deliveries remain in the next Pump's queue.
func (g *Group) landCancelRuns() bool {
	g.mu.Lock()
	if !g.cancelRunsQueued {
		g.mu.Unlock()
		return false
	}
	g.cancelRunsQueued = false
	var landed []delivery
	kept := g.inputs[:0]
	for _, d := range g.inputs {
		if d.kind == "cancel-run" {
			landed = append(landed, d)
		} else {
			kept = append(kept, d)
		}
	}
	clear(g.inputs[len(kept):])
	g.inputs = kept
	g.mu.Unlock()
	for _, d := range landed {
		g.record("cancel-run", true, []string{d.fields["run"]}, nil)
		g.applyCancelRun(d)
	}
	return len(landed) > 0
}
