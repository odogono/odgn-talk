package check

import "github.com/odogono/odgn-talk/impl/go/internal/syntax"

// Decision checks follow chapter 5's possible paths, including loop back
// edges and caught errors. Early exits cannot make a later Verdict reachable.
func (u *Unit) checkDecisions() {
	called := map[string]bool{}
	for _, b := range u.Bodies {
		if u.inheritedBody(b) {
			continue
		}
		syntax.Walk(b.Node, func(x *syntax.Node) bool {
			if x != b.Node && (x.Kind == "lambda" || x.Kind == "event") {
				return false
			}
			if x.Kind == "call" || x.Kind == "command" {
				if s, ok := u.Resolve(b, x.Text); ok && s.Kind == "handler" {
					called[s.Name] = true
				}
			}
			return true
		})
	}
	for _, b := range u.Bodies {
		deciding := b.Kind == "handler" && syntax.HasFlag(b.Node, "deciding")
		syntax.Walk(b.Node, func(n *syntax.Node) bool {
			if n != b.Node && n.Kind == "lambda" {
				return false
			}
			if n.Kind == "veto" && (!deciding || called[b.Name] || u.Options.Library) {
				u.add("veto outside a decision", n.Pos())
			}
			return true
		})
		if deciding && !u.inheritedBody(b) {
			f := decisionFlow{unit: u, body: b}
			entry := f.node(nil, false)
			f.block([]*decisionPoint{entry}, b.Node.Body, decisionContext{})
			// Handler-level finally is visited for diagnostics above, but can't
			// suspend or contain a Verdict, so it adds no Verdict paths here.
			f.check(entry)
		}
	}
}

type decisionPoint struct {
	stmt *syntax.Node
	wait bool
	next []decisionEdge
}
type decisionEdge struct {
	to    *decisionPoint
	after bool
}
type decisionContext struct {
	errors     []*decisionPoint
	exit, next *decisionPoint
	join       bool
}
type decisionFlow struct {
	unit *Unit
	body *Body
}

func (f *decisionFlow) node(n *syntax.Node, wait bool) *decisionPoint {
	return &decisionPoint{stmt: n, wait: wait}
}
func connectDecision(from []*decisionPoint, to *decisionPoint, after bool) {
	if to == nil {
		return
	}
	for _, p := range from {
		p.next = append(p.next, decisionEdge{to, after})
	}
}
func (f *decisionFlow) suspends(n *syntax.Node) bool {
	switch n.Kind {
	case "wait", "wait-for", "wait-any", "join":
		return true
	case "send", "ask", "call-statement":
		return syntax.HasFlag(n, "and")
	case "command":
		if syntax.HasFlag(n, "and") {
			return true
		}
		s, ok := f.unit.Resolve(f.body, n.Text)
		if ok && s.Kind == "handler" {
			for _, b := range f.unit.Bodies {
				if b.Kind == "handler" && b.Name == s.Name && b.MaySuspend {
					return true
				}
			}
		}
	}
	return false
}
func (f *decisionFlow) block(tails []*decisionPoint, statements []*syntax.Node, ctx decisionContext) []*decisionPoint {
	for _, n := range statements {
		p := f.node(n, !ctx.join && f.suspends(n))
		connectDecision(tails, p, true)
		for _, target := range ctx.errors {
			connectDecision([]*decisionPoint{p}, target, false)
			// Awaited calls can fail after resumption as well as before it.
			if n.Kind == "ask" || n.Kind == "send" || n.Kind == "command" || n.Kind == "call-statement" {
				connectDecision([]*decisionPoint{p}, target, true)
			}
		}
		tails = []*decisionPoint{p}
		switch n.Kind {
		case "return", "veto", "pass", "throw":
			tails = nil
		case "exit":
			connectDecision(tails, ctx.exit, true)
			tails = nil
		case "next":
			connectDecision(tails, ctx.next, true)
			tails = nil
		case "if", "match":
			var ends []*decisionPoint
			for _, arm := range n.Branches {
				ends = append(ends, f.block(tails, arm.Body, ctx)...)
			}
			ends = append(ends, f.block(tails, n.Body, ctx)...)
			tails = ends
		case "repeat":
			exit := f.node(nil, false)
			if n.Text != "forever" {
				connectDecision(tails, exit, true)
			}
			loop := ctx
			loop.exit, loop.next = exit, p
			connectDecision(f.block(tails, n.Body, loop), p, true)
			tails = []*decisionPoint{exit}
		case "try":
			exit, exceptional := f.node(nil, false), f.node(nil, false)
			var finally []*syntax.Node
			var catches []*syntax.Node
			for _, branch := range n.Branches {
				if branch.Kind == "finally" {
					finally = branch.Body
				} else {
					catches = append(catches, branch)
				}
			}
			for _, target := range ctx.errors {
				connectDecision(f.block([]*decisionPoint{exceptional}, finally, ctx), target, true)
			}
			inner := ctx
			inner.errors = []*decisionPoint{exceptional}
			var catchEntries []*decisionPoint
			var normal []*decisionPoint
			for _, c := range catches {
				entry := f.node(nil, false)
				catchEntries = append(catchEntries, entry)
				normal = append(normal, f.block([]*decisionPoint{entry}, c.Body, inner)...)
			}
			inner.errors = append(inner.errors, catchEntries...)
			normal = append(normal, f.block(tails, n.Body, inner)...)
			connectDecision(f.block(normal, finally, ctx), exit, true)
			tails = []*decisionPoint{exit}
		case "join":
			p.wait = false
			inner := ctx
			inner.join = true
			end := f.node(nil, true)
			connectDecision(f.block(tails, n.Body, inner), end, true)
			for _, target := range ctx.errors {
				connectDecision([]*decisionPoint{end}, target, true)
			}
			tails = []*decisionPoint{end}
		case "wait-any":
			var ends []*decisionPoint
			for _, branch := range n.Branches {
				ends = append(ends, f.block(tails, branch.Body, ctx)...)
			}
			tails = ends
		}
	}
	return tails
}
func (f *decisionFlow) check(entry *decisionPoint) {
	type path struct {
		point  *decisionPoint
		waited bool
	}
	work := []path{{entry, false}}
	seen := map[path]bool{}
	for len(work) > 0 {
		p := work[len(work)-1]
		work = work[:len(work)-1]
		if seen[p] {
			continue
		}
		seen[p] = true
		if p.waited && p.point.stmt != nil && (p.point.stmt.Kind == "veto" || p.point.stmt.Kind == "pass") {
			f.unit.add("after a suspension", p.point.stmt.Pos())
		}
		for _, e := range p.point.next {
			work = append(work, path{e.to, p.waited || e.after && p.point.wait})
		}
	}
}
