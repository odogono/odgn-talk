package northtalk

// Stop queues sticky Script termination, without finally cleanup. During a
// Pump it lands at the next Host crossing or the Pump's end, like CancelRun.
func (s *Script) Stop(reason string) {
	s.group.backend.control(s, "stop", map[string]any{"reason": reason})
	return
}
