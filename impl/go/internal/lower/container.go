package lower

import (
	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
	"slices"
)

type level struct {
	node         *syntax.Node
	index, whole int
}

func (u *Unit) container(n *syntax.Node) {
	pos := n.Pos()
	index := 0
	if slices.Contains([]string{"put", "add", "subtract", "replace"}, n.Kind) {
		index = 1
	}
	unwrap := func(node *syntax.Node) *syntax.Node {
		for node.Kind == "paren" {
			node = node.Children[0]
		}
		return node
	}
	c := unwrap(n.Children[index])
	var delimiter *syntax.Node
	if c.Kind == "delimited" {
		delimiter = c.Children[1]
		c = unwrap(c.Children[0])
	}
	levels := []level{}
	root := c
	for root.Kind == "chunk" || root.Kind == "key" || root.Kind == "key-computed" {
		levels = append(levels, level{node: root, index: -1, whole: -1})
		root = unwrap(root.Children[len(root.Children)-1])
	}
	value := -1
	temps := []int{}
	allocate := func() int { slot := u.temp(); temps = append(temps, slot); return slot }
	deleting := n.Kind == "delete"
	if len(levels) == 0 {
		switch n.Kind {
		case "delete":
			u.value(pos, "nothing")
		case "put":
			if n.Text == "into" {
				u.expression(n.Children[0])
			} else {
				u.expression(n.Children[0])
				value = allocate()
				u.store(pos, value)
				u.named(root, false, pos)
				u.load(pos, value)
				u.emit(pos, u.writeOp(n))
			}
		case "add", "subtract":
			u.expression(n.Children[0])
			value = allocate()
			u.store(pos, value)
			u.named(root, false, pos)
			u.load(pos, value)
			u.emit(pos, n.Kind)
		case "multiply", "divide":
			u.named(root, false, pos)
			u.expression(n.Children[1])
			value = allocate()
			u.store(pos, value)
			u.load(pos, value)
			u.emit(pos, n.Kind)
		case "replace":
			u.expression(n.Children[0])
			value = allocate()
			u.store(pos, value)
			u.load(pos, value)
			u.named(root, false, pos)
			u.replace(n)
		}
		u.named(root, true, pos)
		for _, slot := range temps {
			u.release(slot)
		}
		return
	}
	if slices.Contains([]string{"put", "add", "subtract", "replace"}, n.Kind) {
		u.expression(n.Children[0])
		value = allocate()
		u.store(pos, value)
	}
	for i := range levels {
		l := &levels[i]
		if l.node.Kind == "chunk" || l.node.Kind == "key-computed" {
			u.expression(l.node.Children[0])
			l.index = allocate()
			u.store(l.node.Pos(), l.index)
		}
	}
	delimiterSlot := -1
	if delimiter != nil {
		u.expression(delimiter)
		delimiterSlot = allocate()
		delimiterPos := levels[0].node.Pos()
		if deleting && len(levels) > 1 {
			delimiterPos = levels[1].node.Pos()
		}
		u.store(delimiterPos, delimiterSlot)
	}
	// A one-level delete needs neither a root temp nor a test: the delete
	// instruction itself does nothing when the final key or chunk is absent.
	if deleting && len(levels) == 1 {
		l := levels[0]
		if l.index >= 0 {
			u.load(l.node.Pos(), l.index)
		}
		u.named(root, false, pos)
		if delimiterSlot >= 0 && l.node.Text == "item" {
			u.load(l.node.Pos(), delimiterSlot)
		}
		u.levelOperation(l, "delete", delimiterSlot, nil)
		u.named(root, true, pos)
		for _, slot := range temps {
			u.release(slot)
		}
		return
	}
	rootWhole := allocate()
	u.named(root, false, pos)
	u.store(pos, rootWhole)
	whole := rootWhole
	skip := &label{}
	for i := len(levels) - 1; i >= 0; i-- {
		l := &levels[i]
		l.whole = whole
		if i == 0 {
			break
		}
		u.levelOperands(*l)
		if deleting {
			if delimiterSlot >= 0 && l.node.Text == "item" {
				u.load(l.node.Pos(), delimiterSlot)
			}
			u.levelOperation(*l, "test", delimiterSlot, skip)
			u.levelOperands(*l)
		}
		if delimiterSlot >= 0 && l.node.Text == "item" {
			u.load(l.node.Pos(), delimiterSlot)
		}
		u.levelOperation(*l, "get", delimiterSlot, nil)
		whole = allocate()
		u.store(l.node.Pos(), whole)
	}
	// Rebuild from the root outward. All outer operands stay on the stack
	// while the leaf is replaced, then each level writes its whole back.
	for i := len(levels) - 1; i >= 0; i-- {
		if deleting && i == 0 {
			if levels[i].index >= 0 {
				u.load(levels[i].node.Pos(), levels[i].index)
			}
			u.load(levels[i+1].node.Pos(), levels[i].whole)
		} else {
			u.levelOperands(levels[i])
		}
	}
	leaf := levels[0]
	if deleting { // Replace the container one level up with its leaf deleted.
		// Undo the leaf's already-emitted index/whole operands: these are exactly
		// the operands the delete consumes, so only its operation remains.
		if delimiterSlot >= 0 && leaf.node.Text == "item" {
			u.expression(delimiter)
		}
		u.levelOperation(leaf, "delete", delimiterSlot, nil)
	} else {
		switch n.Kind {
		case "put":
			if n.Text != "into" {
				u.oldLeaf(leaf, delimiterSlot)
			}
			u.load(pos, value)
			if n.Text != "into" {
				u.emit(pos, u.writeOp(n))
			}
		case "add", "subtract":
			u.oldLeaf(leaf, delimiterSlot)
			u.load(pos, value)
			u.emit(pos, n.Kind)
		case "multiply", "divide":
			u.oldLeaf(leaf, delimiterSlot)
			u.expression(n.Children[1])
			value = allocate()
			u.store(pos, value)
			u.load(pos, value)
			u.emit(pos, n.Kind)
		case "replace":
			u.load(pos, value)
			u.oldLeaf(leaf, delimiterSlot)
			u.replace(n)
		}
		if delimiterSlot >= 0 && leaf.node.Text == "item" {
			u.load(leaf.node.Pos(), delimiterSlot)
		}
		u.levelOperation(leaf, "set", delimiterSlot, nil)
	}
	for i := 1; i < len(levels); i++ {
		l := levels[i]
		if delimiterSlot >= 0 && l.node.Text == "item" {
			u.load(l.node.Pos(), delimiterSlot)
		}
		u.levelOperation(l, "set", delimiterSlot, nil)
	}
	u.named(root, true, pos)
	u.mark(skip)
	for _, slot := range temps {
		u.release(slot)
	}
}
func (u *Unit) writeOp(n *syntax.Node) string {
	op := "append"
	if n.Text == "before" {
		op = "prepend"
	}
	if syntax.HasFlag(n, "...") {
		op += "-all"
	}
	return op
}
func (u *Unit) levelOperands(l level) {
	if l.index >= 0 {
		u.load(l.node.Pos(), l.index)
	}
	u.load(l.node.Pos(), l.whole)
}
func (u *Unit) oldLeaf(l level, delimiter int) {
	u.levelOperands(l)
	if delimiter >= 0 && l.node.Text == "item" {
		u.load(l.node.Pos(), delimiter)
	}
	u.levelOperation(l, "get", delimiter, nil)
}
func (u *Unit) levelOperation(l level, op string, delimiter int, fail *label) {
	n := l.node
	name := ""
	args := []operand{}
	if n.Kind == "chunk" {
		name = "chunk-" + op
		if op == "test" {
			name = "test-chunk"
		}
		if delimiter >= 0 && n.Text == "item" {
			name += "-delimited"
		}
		args = append(args, text(n.Text))
	} else {
		name = op + "-key"
		if n.Kind == "key-computed" {
			name += "-computed"
		} else {
			args = append(args, text(quote(n.Text)))
		}
	}
	if fail != nil {
		args = append(args, target(fail))
	}
	u.emit(n.Pos(), name, args...)
}
