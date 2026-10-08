package northtalk

// CancelRun queues cleanup at a Host crossing or the Pump's end.
func (s *Script) CancelRun(id RunID) {
	g := s.group
	g.mu.Lock()
	g.controlsQueued = true
	g.inputs = append(g.inputs, delivery{kind: "cancel-run", script: s, fields: map[string]string{"run": string(id)}})
	ready := g.options.OnReady
	g.mu.Unlock()
	if ready != nil {
		ready()
	}
}
func (g *Group) applyCancelRun(d delivery, reports *[]Report) {
	for _, x := range d.script.runs {
		if string(x.id) == d.fields["run"] {
			g.cancelExecution(d.script, x, reports)
			return
		}
	}
}

// Stop and cancellation may be taken from inputs while a Pump is running.
// Refused-input records land alongside them; ordinary settlements and Deliveries
// remain in the next Pump's queue.
func (g *Group) landControls(reports *[]Report, current *execution, stop func(delivery)) bool {
	g.mu.Lock()
	if !g.controlsQueued {
		g.mu.Unlock()
		return false
	}
	g.controlsQueued = false
	var landed []delivery
	kept := g.inputs[:0]
	for _, d := range g.inputs {
		if d.kind == "cancel-run" || d.kind == "stop" || d.kind == "rewind-run" || d.kind == "refusal" {
			landed = append(landed, d)
		} else {
			kept = append(kept, d)
		}
	}
	clear(g.inputs[len(kept):])
	g.inputs = kept
	g.mu.Unlock()
	for _, d := range landed {
		if d.kind == "refusal" {
			g.emit(d.refusal...)
		} else if d.kind == "stop" {
			g.record("stop", true, []string{d.script.name}, d.fields)
			stop(d)
		} else if d.kind == "rewind-run" {
			g.record("rewind-run", true, []string{d.fields["run"]}, nil)
			g.applyRewindRun(d, current, reports)
		} else {
			g.record("cancel-run", true, []string{d.fields["run"]}, nil)
			g.applyCancelRun(d, reports)
		}
	}
	return len(landed) > 0
}
