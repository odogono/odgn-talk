package lower

import (
	"github.com/odogono/odgn-talk/impl/go/internal/check"
	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
	"strings"
)

type bindingMove struct {
	name string
	slot int
}

func (u *Unit) bind(n *syntax.Node, direct bool, pos syntax.Position) {
	if n.Text == "" || n.Text == "_" {
		u.emit(pos, "pop")
		return
	}
	slot := u.state.body.Checked.Slot(n.Text)
	if !direct {
		slot = u.temp()
		u.state.overrides[n.Text] = slot
		u.state.moves = append(u.state.moves, bindingMove{n.Text, slot})
	}
	u.store(pos, slot)
}
func (u *Unit) subpattern(n *syntax.Node, fail *label, direct, fold bool) {
	switch n.Kind {
	case "binding":
		u.bind(n, direct, n.Pos())
	case "wildcard":
		u.emit(n.Pos(), "pop")
	default:
		slot := u.temp()
		u.store(n.Pos(), slot)
		u.pattern(n, slot, fail, direct, fold)
		u.release(slot)
	}
}
func (u *Unit) pattern(n *syntax.Node, slot int, fail *label, direct, fold bool) {
	pos := n.Pos()
	failure := []operand{}
	if fold {
		failure = append(failure, text("fold"))
	}
	failure = append(failure, target(fail))
	switch n.Kind {
	case "name", "binding":
		u.load(pos, slot)
		u.bind(n, direct, pos)
	case "wildcard":
	case "binding-as":
		u.pattern(n.Children[0], slot, fail, direct, fold)
		u.load(pos, slot)
		u.bind(n, direct, pos)
	case "literal", "negative-pattern":
		u.load(pos, slot)
		args := []operand{u.constant(literal(n))}
		args = append(args, failure...)
		u.emit(pos, "test-constant", args...)
	case "pin":
		u.load(pos, slot)
		u.named(n, false, pos)
		u.emit(pos, "test-equal", target(fail))
	case "pattern-list":
		count := len(n.Children)
		rest := count > 0 && n.Children[count-1].Kind == "rest"
		if rest {
			count--
		}
		u.load(pos, slot)
		op := "test-list"
		if rest {
			op = "test-list-at-least"
		}
		u.emit(pos, op, number(count), target(fail))
		for i := 0; i < count; i++ {
			u.load(pos, slot)
			u.emit(pos, "list-item", number(i+1))
			u.subpattern(n.Children[i], fail, direct, fold)
		}
		if rest {
			u.load(pos, slot)
			u.emit(pos, "list-rest", number(count+1))
			u.bind(n.Children[count], direct, pos)
		}
	case "pattern-map":
		u.load(pos, slot)
		u.emit(pos, "test-map", target(fail))
		for _, entry := range n.Children {
			u.load(pos, slot)
			u.emit(pos, "map-get", text(quote(entry.Text)), target(fail))
			u.subpattern(entry.Children[0], fail, direct, fold)
		}
	case "text-pattern":
		u.load(pos, slot)
		u.expression(n)
		u.emit(pos, "match-whole", failure...)
		u.captureBindings(n, direct, false)
	case "pattern-binary":
		u.load(pos, slot)
		u.emit(pos, "bin-start", target(fail))
		rest := false
		for i := 0; i < len(n.Children); i++ {
			field := n.Children[i]
			switch field.Kind {
			case "binary-literal":
				value := literal(field)
				u.emit(field.Pos(), "bin-literal", u.constant(value), target(fail))
			case "binary-rest":
				args := []operand{}
				kind := "bytes"
				if field.Text != "" {
					kind += " " + field.Text
				}
				args = append(args, text(kind))
				args = append(args, target(fail))
				u.emit(field.Pos(), "bin-rest", args...)
				if len(field.Params) > 0 {
					u.bind(field.Params[0], direct, field.Pos())
				} else {
					u.emit(field.Pos(), "pop")
				}
				rest = true
			case "binary-field":
				if field.Text == "bits" {
					widths := []string{}
					fields := []*syntax.Node{}
					first := field
					for i < len(n.Children) && n.Children[i].Text == "bits" {
						fields = append(fields, n.Children[i])
						widths = append(widths, n.Children[i].Children[0].Text)
						i++
					}
					i--
					u.emit(first.Pos(), "bin-bits", u.constant("["+strings.Join(widths, ", ")+"]"), number(len(fields)), target(fail))
					for j := len(fields) - 1; j >= 0; j-- {
						u.bind(fields[j].Params[0], direct, fields[j].Pos())
					}
				} else {
					if len(field.Children) > 0 {
						size := *field.Children[0]
						if size.Kind != "paren" {
							size.Token.Pos = field.Pos()
						}
						u.expression(&size)
						u.emit(field.Pos(), "bin-bytes", text(field.Text), target(fail))
					} else {
						u.emit(field.Pos(), "bin-int", text(field.Text), target(fail))
					}
					u.bind(field.Params[0], direct, field.Pos())
				}
			}
		}
		if !rest {
			u.emit(pos, "bin-end", target(fail))
		}
	default:
		panic("unhandled pattern " + n.Kind)
	}
}
func (u *Unit) captureBindings(n *syntax.Node, direct, matchObject bool) {
	captures := check.Bindings(n)
	if len(captures) == 0 {
		u.emit(n.Pos(), "pop")
		return
	}
	slot := u.temp()
	u.store(n.Pos(), slot)
	for _, capture := range captures {
		u.load(n.Pos(), slot)
		if matchObject {
			u.emit(n.Pos(), "get-key", text(quote("captures")))
		}
		u.emit(n.Pos(), "get-key", text(quote(capture.Text)))
		u.bind(capture, direct, n.Pos())
	}
	u.release(slot)
}
func (u *Unit) beginBindings() func() {
	old := u.state.overrides
	oldMoves := u.state.moves
	next := map[string]int{}
	for k, v := range old {
		next[k] = v
	}
	u.state.overrides = next
	u.state.moves = nil
	return func() { u.state.overrides = old; u.state.moves = oldMoves }
}
func (u *Unit) commitBindings(pos syntax.Position) {
	for _, move := range u.state.moves {
		u.emit(pos, "move", ref("local", move.slot), ref("local", u.state.body.Checked.Slot(move.name)))
		u.release(move.slot)
	}
}
