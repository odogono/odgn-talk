package machine

// Calls and returns adjust the cached depth. Bulk control transfers invalidate
// it; the next check rebuilds the union of live and retained real frames once.
// This is derived state, so snapshots do not encode it.
func (r *Run) invalidateDepth() {
	r.depthValid = false
	r.depthRetained = nil
}

func (r *Run) setFrames(frames []Frame) {
	r.Frames = frames
	r.invalidateDepth()
}

func (r *Run) popFrame() Frame {
	i := len(r.Frames) - 1
	f := r.Frames[i]
	if r.depthValid && !f.Recovery && !r.depthRetained[f.ID] {
		r.depth--
	}
	r.Frames[i] = Frame{}
	r.Frames = r.Frames[:i]
	return f
}

func (r *Run) realDepth() int {
	if r.depthValid {
		return r.depth
	}
	var retained map[int]bool
	if len(r.CancellationOwners)+len(r.Cancellation)+len(r.Recoveries) > 0 {
		retained = map[int]bool{}
		for _, f := range r.CancellationOwners {
			retained[f.ID] = true
		}
		for _, scope := range r.Cancellation {
			id := scope.Frame.ID
			if scope.Frame.OwnerID != 0 {
				id = scope.Frame.OwnerID
			}
			retained[id] = true
		}
		for _, c := range r.Recoveries {
			for _, f := range c.Retained {
				if !f.Recovery {
					retained[f.ID] = true
				}
			}
		}
	}
	depth := len(retained)
	// Live real frames have distinct IDs. A cleanup cursor may also occur in
	// retained storage; a synthetic catch activation never adds a real frame.
	for _, f := range r.Frames {
		if !f.Recovery && !retained[f.ID] {
			depth++
		}
	}
	r.depth, r.depthRetained, r.depthValid = depth, retained, true
	return depth
}
