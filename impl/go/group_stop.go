package northtalk

import corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"

// Stop queues sticky Script termination, without finally cleanup. During a
// Pump it lands at the next Host crossing or the Pump's end, like CancelRun.
func (s *Script) Stop(reason string) {
	g := s.group
	g.mu.Lock()
	g.controlsQueued = true
	g.inputs = append(g.inputs, delivery{kind: "stop", script: s, reason: reason, fields: map[string]string{"reason": corevalue.DisplayText(reason)}})
	ready := g.options.OnReady
	g.mu.Unlock()
	if ready != nil {
		ready()
	}
}
