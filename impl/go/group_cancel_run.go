package northtalk

// CancelRun queues cleanup at a Host crossing or the Pump's end.
func (s *Script) CancelRun(id RunID) {
	s.group.backend.control(s, "cancel-run", map[string]any{"run": id})
	return
}
