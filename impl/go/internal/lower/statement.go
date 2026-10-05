package lower

import (
	"github.com/odogono/odgn-talk/impl/go/internal/check"
	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
	"strconv"
)

func (u *Unit) statements(nodes []*syntax.Node) {
	for _, n := range nodes {
		u.statement(n)
	}
}
func (u *Unit) statement(n *syntax.Node) {
	pos := n.Pos()
	switch n.Kind {
	case "put", "add", "subtract", "multiply", "divide", "replace", "delete":
		u.container(n)
	case "set":
		c := n.Children[0]
		if c.Kind == "key-computed" {
			u.expression(c.Children[0])
			u.expression(c.Children[1])
			u.expression(n.Children[1])
			u.emit(pos, "set-property-computed")
		} else {
			u.expression(c.Children[0])
			u.expression(n.Children[1])
			u.emit(pos, "set-property", text(quote(c.Text)))
		}
	case "let":
		u.expression(n.Children[1])
		slot := u.temp()
		u.store(pos, slot)
		fail, end := &label{}, &label{}
		restore := u.beginBindings()
		u.pattern(n.Children[0], slot, fail, false, false)
		u.commitBindings(pos)
		restore()
		u.release(slot)
		u.emit(pos, "jump", target(end))
		u.mark(fail)
		u.emit(pos, "raise", text("no match"))
		u.mark(end)
	case "if":
		end := &label{}
		for i, arm := range n.Branches {
			next := &label{}
			u.expression(arm.Children[0])
			u.emit(pos, "branch-false", target(next))
			u.statements(arm.Body)
			if i < len(n.Branches)-1 || n.HasElse {
				u.emit(pos, "jump", target(end))
			}
			u.mark(next)
		}
		u.statements(n.Body)
		u.mark(end)
	case "repeat":
		u.repeat(n)
	case "exit", "next":
		loop := u.state.loops[len(u.state.loops)-1]
		paused := u.inlineFinally(loop.finally)
		dest := loop.end
		if n.Kind == "next" {
			dest = loop.start
		}
		u.emit(pos, "jump", target(dest))
		u.resumeRegions(paused)
	case "match":
		u.match(n)
	case "try":
		u.tryStatement(n)
	case "throw":
		u.expression(n.Children[0])
		u.emit(pos, "throw")
	case "return", "veto":
		if len(n.Children) > 0 {
			u.expression(n.Children[0])
		} else {
			u.value(pos, "nothing")
		}
		var paused []*region
		slot := -1
		if len(u.state.finally) > 0 {
			slot = u.temp()
			u.store(pos, slot)
			paused = u.inlineFinally(0)
			u.load(pos, slot)
		}
		u.emit(pos, n.Kind)
		if slot >= 0 {
			u.release(slot)
			u.resumeRegions(paused)
		}
	case "pass":
		paused := u.inlineFinally(0)
		u.emit(pos, "pass", text(n.Text))
		u.resumeRegions(paused)
	case "command":
		for _, arg := range n.Children {
			u.expression(arg)
		}
		if n.Text == "say" {
			u.emit(pos, "tell", text("console"), text("write"), number(len(n.Children)))
			return
		}
		s, known := u.checked.Symbols[n.Text]
		op := "send-up"
		if known && s.Kind == "handler" {
			op = "call-handler"
		}
		wait := syntax.HasFlag(n, "and")
		if wait {
			op += "-wait"
		}
		name := n.Text
		if s.Import != "" {
			name = s.Import
		}
		u.emit(pos, op, text(name), number(len(n.Children)))
		if known && s.Kind == "handler" || wait {
			u.store(pos, 0)
		}
	case "call-statement":
		u.call(n.Children[0], syntax.HasFlag(n, "and"))
		u.store(pos, 0)
	case "ask", "tell":
		for _, arg := range n.Children {
			u.expression(arg)
		}
		op := n.Kind
		wait := syntax.HasFlag(n, "and")
		if n.Kind == "ask" && wait {
			if u.state.join > 0 {
				op = "join-ask"
			} else {
				op = "ask-wait"
			}
		}
		u.emit(pos, op, text(n.Params[0].Text), text(n.Text), number(len(n.Children)))
		if n.Kind == "ask" && op != "join-ask" {
			u.store(pos, 0)
		}
	case "send":
		// A computed name is evaluated first, below the arguments (ADR 0057).
		named := len(n.Params) > 1
		if named {
			u.expression(n.Params[1])
		}
		for _, arg := range n.Children {
			u.expression(arg)
		}
		u.expression(n.Params[0])
		op := "send"
		if syntax.HasFlag(n, "and") {
			if u.state.join > 0 {
				op = "join-send"
			} else {
				op = "send-wait"
			}
		}
		if named {
			op = map[string]string{"send": "send-named", "send-wait": "send-named-wait", "join-send": "join-send-named"}[op]
			u.emit(pos, op, number(len(n.Children)))
		} else {
			u.emit(pos, op, text(n.Text), number(len(n.Children)))
		}
		if op == "send-wait" || op == "send-named-wait" {
			u.store(pos, 0)
		}
	case "wait":
		u.expression(n.Children[0])
		u.emit(pos, "wait")
	case "join":
		u.emit(pos, "join-start")
		u.state.join++
		u.statements(n.Body)
		u.state.join--
		u.emit(n.End.Pos, "join-end")
		u.store(pos, 0)
	case "wait-for", "wait-any":
		u.wait(n)
	default:
		panic("unhandled statement " + n.Kind)
	}
}
func (u *Unit) repeat(n *syntax.Node) {
	pos := n.Pos()
	start, end := &label{}, &label{}
	iterator := n.Text == "each" || n.Text == "times"
	if iterator {
		u.expression(n.Children[0])
		op := "iterate"
		if n.Text == "times" {
			op = "iterate-times"
		}
		u.emit(pos, op)
	}
	u.mark(start)
	u.state.loops = append(u.state.loops, loop{start, end, len(u.state.finally), iterator})
	if iterator {
		u.emit(pos, "next", target(end))
		if n.Text == "times" {
			u.emit(pos, "pop")
		} else {
			p := n.Params[0]
			if p.Kind == "binding" {
				u.named(p, true, pos)
			} else {
				slot := u.temp()
				u.store(pos, slot)
				fail, next := &label{}, &label{}
				restore := u.beginBindings()
				u.pattern(p, slot, fail, false, false)
				u.commitBindings(pos)
				restore()
				u.release(slot)
				u.emit(pos, "jump", target(next))
				u.mark(fail)
				u.emit(pos, "raise", text("no match"))
				u.mark(next)
			}
		}
	} else if n.Text == "while" || n.Text == "until" {
		u.expression(n.Children[0])
		op := "branch-false"
		if n.Text == "until" {
			op = "branch-true"
		}
		u.emit(pos, op, target(end))
	}
	u.statements(n.Body)
	u.emit(pos, "jump", target(start))
	u.mark(end)
	if iterator {
		u.emit(pos, "pop")
	}
	u.state.loops = u.state.loops[:len(u.state.loops)-1]
}
func (u *Unit) match(n *syntax.Node) {
	pos := n.Pos()
	u.expression(n.Children[0])
	slot := u.temp()
	u.store(pos, slot)
	end := &label{}
	fold := syntax.HasFlag(n, "ignoring")
	for _, branch := range n.Branches {
		fail := &label{}
		restore := u.beginBindings()
		start := u.pc()
		pattern := branch.Params[0]
		if syntax.HasFlag(branch, "contains") {
			u.load(pattern.Pos(), slot)
			u.expression(pattern)
			args := []operand{}
			if fold {
				args = append(args, text("fold"))
			}
			args = append(args, target(fail))
			u.emit(pattern.Pos(), "match-search", args...)
			u.captureBindings(pattern, false, false)
		} else {
			u.pattern(pattern, slot, fail, false, fold)
		}
		if branch.Guard != nil {
			u.expression(branch.Guard)
			u.emit(branch.Guard.FirstPos(), "branch-false", target(fail))
		}
		if stop := u.pc(); stop > start {
			u.state.body.Unwind = append(u.state.body.Unwind, unwind{start, stop - 1, "guard", fail, u.depth()})
		}
		u.commitBindings(branch.Pos())
		restore()
		u.statements(branch.Body)
		u.emit(branch.Pos(), "jump", target(end))
		u.mark(fail)
	}
	u.statements(n.Body)
	u.mark(end)
	u.release(slot)
}
func (u *Unit) replace(n *syntax.Node) {
	pos := n.Pos()
	first := 0
	if syntax.HasFlag(n, "first") {
		first = 1
	}
	u.emit(pos, "replace-start", number(first))
	start, end := &label{}, &label{}
	u.mark(start)
	u.emit(pos, "replace-next", target(end))
	slot := u.temp()
	u.store(pos, slot)
	for _, capture := range check.Bindings(n.Children[0]) {
		u.load(pos, slot)
		u.emit(pos, "get-key", text(quote("captures")))
		u.emit(pos, "get-key", text(quote(capture.Text)))
		u.named(capture, true, pos)
	}
	u.release(slot)
	u.expression(n.Children[2])
	u.emit(pos, "replace-put")
	u.emit(pos, "jump", target(start))
	u.mark(end)
	u.emit(pos, "replace-end")
}
func (u *Unit) wait(n *syntax.Node) {
	ev := Event{Timeout: len(n.Children) > 0}
	pos := n.Pos()
	for _, branch := range n.Branches {
		b := EventBranch{Message: branch.Text, Body: -1}
		if branch.Kind == "after" {
			u.expression(branch.Children[0])
			b.After = true
		} else {
			if len(branch.Children) > 0 {
				u.expression(branch.Children[0])
				b.From = true
				if source := branch.Children[0]; source.Kind == "name" {
					if _, ok := u.checked.Resolve(u.state.body.Checked, source.Text); !ok {
						b.FromScript = source.Text
					}
				}
			}
			if len(branch.Params) > 0 || branch.Guard != nil {
				body := u.extra(branch)
				b.Body = body.Index
				b.Captures = len(body.Checked.Captures)
				for _, capture := range body.Checked.Captures {
					u.load(branch.Pos(), capture.Index)
				}
				for _, param := range branch.Params {
					for _, binding := range check.Bindings(param) {
						b.Binds = append(b.Binds, u.state.body.Checked.Slot(binding.Text))
					}
				}
			}
		}
		ev.Branches = append(ev.Branches, b)
	}
	if len(n.Children) > 0 {
		u.expression(n.Children[0])
	}
	i := len(u.Events)
	u.Events = append(u.Events, ev)
	if n.Kind == "wait-for" {
		u.emit(pos, "wait-for", number(i))
		u.store(pos, 0)
		return
	}
	u.emit(pos, "wait-for-any", number(i))
	slot := u.temp()
	u.store(pos, slot)
	u.store(pos, 0)
	end := &label{}
	for j, branch := range n.Branches {
		fail := &label{}
		u.load(branch.Pos(), slot)
		u.value(branch.Pos(), strconv.Itoa(j+1))
		u.emit(branch.Pos(), "equal")
		u.emit(branch.Pos(), "branch-false", target(fail))
		u.statements(branch.Body)
		u.emit(branch.Pos(), "jump", target(end))
		u.mark(fail)
	}
	u.mark(end)
	u.release(slot)
}
