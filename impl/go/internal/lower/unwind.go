package lower

import "github.com/odogono/odgn-talk/impl/go/internal/syntax"

type region struct {
	scope, start int
	spans        [][2]int
	active       bool
}

func (u *Unit) closeRegion(r *region) {
	if r.active {
		if end := u.pc(); end > r.start {
			r.spans = append(r.spans, [2]int{r.start, end - 1})
		}
		r.active = false
	}
}
func (u *Unit) pauseRegions(scope int) []*region {
	paused := []*region{}
	for _, r := range u.state.regions {
		if r.scope >= scope && r.active {
			u.closeRegion(r)
			paused = append(paused, r)
		}
	}
	return paused
}
func (u *Unit) resumeRegions(regions []*region) {
	for _, r := range regions {
		r.start = u.pc()
		r.active = true
	}
}
func (u *Unit) inlineFinally(from int) []*region {
	if from >= len(u.state.finally) {
		return nil
	}
	finals := append([]*finalizer{}, u.state.finally...)
	paused := u.pauseRegions(finals[from].scope)
	for i := len(finals) - 1; i >= from; i-- {
		u.state.finally = append([]*finalizer{}, finals[:i]...)
		u.statements(finals[i].node.Body)
	}
	u.state.finally = finals
	return paused
}
func (u *Unit) tryStatement(n *syntax.Node) {
	pos := n.Pos()
	end, catch, cleanup := &label{}, &label{}, &label{}
	depth := u.depth()
	scope := len(u.state.regions)
	bodyRegion := &region{scope: scope, start: u.pc(), active: true}
	u.state.regions = append(u.state.regions, bodyRegion)
	var final *syntax.Node
	var catches, offers []*syntax.Node
	for _, branch := range n.Branches {
		if branch.Kind == "finally" {
			final = branch
		} else if branch.Kind == "offer" {
			offers = append(offers, branch)
		} else {
			catches = append(catches, branch)
		}
	}
	var finalRegion *region
	if final != nil {
		finalRegion = &region{scope: scope, start: u.pc(), active: true}
		u.state.regions = append(u.state.regions, finalRegion)
		u.state.finally = append(u.state.finally, &finalizer{node: final, scope: scope})
	}
	u.statements(n.Body)
	u.closeRegion(bodyRegion)
	if final != nil {
		u.inlineFinally(len(u.state.finally) - 1)
	}
	u.emit(pos, "jump", target(end))
	// Catch's error store is outside every span owned by this try.
	if final != nil {
		u.closeRegion(finalRegion)
	}
	u.mark(catch)
	if len(catches) > 0 {
		for _, span := range bodyRegion.spans {
			u.state.body.Unwind = append(u.state.body.Unwind, unwind{span[0], span[1], "catch", catch, depth})
		}
		// Dispatch scratch cannot overwrite a retained protected-body continuation.
		retainedTemps := append([]bool(nil), u.state.temps...)
		for i := range u.state.temps {
			u.state.temps[i] = true
		}
		slot := u.temp()
		u.store(catches[0].Pos(), slot)
		if finalRegion != nil {
			finalRegion.start = u.pc()
			finalRegion.active = true
		}
		for _, branch := range catches {
			fail := &label{}
			restore := u.beginBindings()
			start := u.pc()
			p := branch.Params[0]
			p = errorPattern(p)
			u.pattern(p, slot, fail, false, false)
			if branch.Guard != nil {
				u.expression(branch.Guard)
				u.emit(branch.Guard.FirstPos(), "branch-false", target(fail))
			}
			if stop := u.pc(); stop > start {
				u.state.body.Unwind = append(u.state.body.Unwind, unwind{start, stop - 1, "guard", fail, depth})
			}
			if !syntax.HasFlag(branch, "before") {
				u.emit(branch.Pos(), "catch-accept")
			}
			u.commitBindings(branch.Pos())
			restore()
			u.statements(branch.Body)
			var paused []*region
			if final != nil && !syntax.HasFlag(branch, "before") {
				paused = u.inlineFinally(len(u.state.finally) - 1)
			}
			if !syntax.HasFlag(branch, "before") {
				u.emit(branch.Pos(), "jump", target(end))
			}
			u.mark(fail)
			if final != nil {
				u.resumeRegions(paused)
				if !finalRegion.active {
					finalRegion.start = u.pc()
					finalRegion.active = true
				}
			}
		}
		u.emit(catches[len(catches)-1].Pos(), "catch-next")
		u.release(slot)
		copy(u.state.temps, retainedTemps)
	}
	if len(offers) > 0 {
		record := &OfferEntry{Body: u.state.body.Index, Depth: depth, end: end, index: &label{}}
		for _, branch := range offers {
			if finalRegion != nil && !finalRegion.active {
				finalRegion.start = u.pc()
				finalRegion.active = true
			}
			descriptor := OfferDescriptor{Name: branch.Text, Target: u.pc()}
			for _, param := range branch.Params {
				descriptor.Binds = append(descriptor.Binds, u.state.body.Checked.Slot(param.Text))
			}
			record.Offers = append(record.Offers, descriptor)
			u.statements(branch.Body)
			var paused []*region
			if final != nil {
				paused = u.inlineFinally(len(u.state.finally) - 1)
			}
			u.emit(branch.Pos(), "jump", target(end))
			u.resumeRegions(paused)
		}
		u.state.body.Offers = append(u.state.body.Offers, record)
		for _, span := range bodyRegion.spans {
			u.state.body.Unwind = append(u.state.body.Unwind, unwind{span[0], span[1], "offer", record.index, depth})
		}
	}
	if finalRegion != nil {
		u.closeRegion(finalRegion)
		u.state.finally = u.state.finally[:len(u.state.finally)-1]
	}
	// Remove this try's regions before emitting its cleanup copy; enclosing
	// tries retain their spans around it, as chapter 8 specifies.
	u.state.regions = u.state.regions[:scope]
	if final != nil {
		u.mark(cleanup)
		u.statements(final.Body)
		u.emit(pos, "end-cleanup")
		for _, span := range finalRegion.spans {
			u.state.body.Unwind = append(u.state.body.Unwind, unwind{span[0], span[1], "finally", cleanup, depth})
		}
	}
	u.mark(end)
}

// Text in an error Handler or catch matches the error map's code key.
func errorPattern(p *syntax.Node) *syntax.Node {
	if p.Kind == "literal" && p.Token.Kind == syntax.Text {
		return &syntax.Node{Kind: "pattern-map", Token: p.Token, Children: []*syntax.Node{{Kind: "entry", Text: "code", Token: p.Token, Children: []*syntax.Node{p}}}}
	}
	return p
}
