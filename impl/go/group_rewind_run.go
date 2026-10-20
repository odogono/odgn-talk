package northtalk

// RewindRun queues a Rewind (ADR 0068). It lands as CancelRun does: at a Host
// crossing or the Pump's end.
func (s *Script) RewindRun(id RunID) {
	s.group.backend.control(s, "rewind-run", map[string]any{"run": id})
	return
}
