package lower

import (
	"github.com/odogono/odgn-talk/impl/go/internal/generated"
	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
	"math/big"
	"slices"
	"strconv"
	"strings"
)

func literal(n *syntax.Node) string {
	if n.Token.Kind == syntax.Text {
		return quote(n.Text)
	}
	if n.Kind == "negative-pattern" {
		return "-" + literal(n.Children[0])
	}
	raw := n.Text
	if strings.HasPrefix(raw, "0x") {
		value, _ := new(big.Int).SetString(raw[2:], 16)
		raw = value.String()
	} else if n.Token.Kind == syntax.Number {
		parts := strings.Split(raw, ".")
		parts[0] = strings.TrimLeft(parts[0], "0")
		if parts[0] == "" {
			parts[0] = "0"
		}
		raw = strings.Join(parts, ".")
	}
	if len(n.Params) > 0 {
		unit := unitDisplay(n.Params[0].Text, raw)
		if unit != "1" {
			raw += " " + unit
		}
	}
	return raw
}
func unitDisplay(unit, num string) string {
	if !strings.ContainsAny(unit, "*/^") {
		for _, u := range generated.Units.Unit {
			if unit == u.Name || unit == u.Plural {
				value, ok := new(big.Rat).SetString(num)
				if (!ok || new(big.Rat).Abs(value).Cmp(big.NewRat(1, 1)) != 0) && u.Plural != "" {
					return u.Plural
				}
				return u.Name
			}
		}
	}
	type factor struct {
		name  string
		power int
	}
	factors := []factor{}
	denom := false
	parts := strings.Split(unit, "/")
	if len(parts) > 1 {
		denom = true
	}
	parse := func(s string, sign int) {
		for _, p := range strings.Split(s, "*") {
			if p == "1" || p == "" {
				continue
			}
			pieces := strings.Split(p, "^")
			name := pieces[0]
			power := 1
			if len(pieces) > 1 {
				power, _ = strconv.Atoi(pieces[1])
			}
			for _, u := range generated.Units.Unit {
				if name == u.Name || name == u.Plural {
					name = u.Name
					break
				}
			}
			found := false
			for i, f := range factors {
				if f.name == name {
					factors[i].power += sign * power
					found = true
					break
				}
			}
			if !found {
				factors = append(factors, factor{name, sign * power})
			}
		}
	}
	parse(parts[0], 1)
	if denom {
		parse(parts[1], -1)
	}

	kindOrder := func(name string) int {
		for _, u := range generated.Units.Unit {
			if u.Name == name {
				for i, k := range generated.Units.Kind {
					if k.Name == u.Kind {
						return i
					}
				}
			}
		}
		return len(generated.Units.Kind)
	}
	slices.SortStableFunc(factors, func(a, b factor) int { return kindOrder(a.name) - kindOrder(b.name) })
	positives, negatives := []string{}, []string{}
	for _, f := range factors {
		p := f.power
		if p == 0 {
			continue
		}
		if p < 0 {
			p = -p
		}
		value := f.name
		if p != 1 {
			value += "^" + strconv.Itoa(p)
		}
		if f.power > 0 {
			positives = append(positives, value)
		} else {
			negatives = append(negatives, value)
		}
	}
	value := strings.Join(positives, "*")
	if value == "" {
		value = "1"
	}
	if len(negatives) > 0 {
		value += "/" + strings.Join(negatives, "*")
	}
	return value
}

func kindDisplay(name string) string {
	for _, unit := range generated.Units.Unit {
		if name == unit.Name || name == unit.Plural {
			return unit.Name
		}
	}
	if strings.ContainsAny(name, "*/^") {
		return unitDisplay(name, "1")
	}
	return name
}

var binaryOps = map[string]string{"+": "add", "-": "subtract", "*": "multiply", "/": "divide", "div": "div", "mod": "mod", "^": "power", "&": "concat", "..": "range", "=": "equal", "is": "equal", "<>": "not-equal", "is not": "not-equal", "<": "less", ">": "greater", "<=": "less-or-equal", ">=": "greater-or-equal", "is in": "member", "is not in": "member", "contains": "contains", "begins with": "begins-with", "ends with": "ends-with", "matches": "matches",
	// The English comparison words (ADR 0075): each `does not` and `is not` form
	// is followed by `not`.
	"does not contain": "contains", "does not begin with": "begins-with", "does not end with": "ends-with", "does not match": "matches",
	"is greater than": "greater", "is less than": "less", "is at least": "greater-or-equal", "is at most": "less-or-equal",
	"is not greater than": "greater", "is not less than": "less", "is not at least": "greater-or-equal", "is not at most": "less-or-equal",
	"comes before": "less", "comes after": "greater"}

func (u *Unit) expression(n *syntax.Node) {
	pos := n.Pos()
	switch n.Kind {
	case "literal":
		if n.Text == "it" {
			// In a Whose Clause's condition, `it` is the chunk being tested.
			slot := 0
			if len(u.state.whoseIt) > 0 {
				slot = u.state.whoseIt[len(u.state.whoseIt)-1]
			}
			u.load(pos, slot)
		} else if n.Text == "me" {
			u.emit(pos, "me")
		} else {
			u.value(pos, literal(n))
		}
	case "name", "pin":
		u.named(n, false, pos)
	case "target":
		u.emit(pos, "target")
	case "paren":
		u.expression(n.Children[0])
	case "ordinal":
		i := slices.Index(generated.Grammar.Ordinals, n.Text) + 1
		if n.Text == "last" {
			i = -1
		}
		u.value(pos, strconv.Itoa(i))
	case "unary":
		u.expression(n.Children[0])
		op := "negate"
		if n.Text == "not" {
			op = "not"
		}
		u.emit(pos, op)
	case "binary":
		u.binaryExpression(n)
	case "kind-test":
		u.expression(n.Children[0])
		op := "is-kind"
		if n.Text == "can be" {
			op = "can-convert"
		}
		u.emit(pos, op, text(kindDisplay(n.Children[1].Text)))
		if n.Text == "is not a" {
			u.emit(pos, "not")
		}
	case "empty-test":
		u.expression(n.Children[0])
		u.emit(pos, "is-empty")
		if n.Text == "is not empty" {
			u.emit(pos, "not")
		}
	case "convert":
		u.expression(n.Children[0])
		u.emit(pos, "convert", text(kindDisplay(n.Children[1].Text)))
	case "key":
		u.expression(n.Children[0])
		op := "get-key"
		arg := quote(n.Text)
		// Quoting always names a key, even when it spells a Built-in property.
		if slices.Contains(generated.Grammar.Properties, n.Text) && (len(n.Params) == 0 || n.Params[0].Token.Kind != syntax.Text) {
			op = "property"
			arg = n.Text
		}
		u.emit(pos, op, text(arg))
	case "key-computed":
		u.expression(n.Children[0])
		u.expression(n.Children[1])
		u.emit(pos, "get-key-computed")
	case "chunk":
		u.chunk(n, nil, false)
	case "whose":
		u.whose(n)
	case "delimited":
		if n.Children[0].Kind == "chunk" {
			u.chunk(n.Children[0], n.Children[1], false)
		} else {
			whole := n.Children[0]
			u.expression(whole.Children[0])
			u.expression(n.Children[1])
			u.emit(whole.Pos(), "property-delimited", text(whole.Text))
		}
	case "list":
		spread := false
		for _, c := range n.Children {
			if c.Kind == "spread" {
				spread = true
			}
		}
		if spread {
			u.emit(pos, "list", number(0))
		}
		for _, c := range n.Children {
			if c.Kind == "spread" {
				u.expression(c.Children[0])
				u.emit(pos, "list-extend")
			} else {
				u.expression(c)
				if spread {
					u.emit(pos, "list-append")
				}
			}
		}
		if !spread {
			u.emit(pos, "list", number(len(n.Children)))
		}
	case "map":
		keys := []string{}
		for _, entry := range n.Children {
			keys = append(keys, quote(entry.Text))
			u.expression(entry.Children[0])
		}
		u.emit(pos, "map", u.constant("["+strings.Join(keys, ", ")+"]"), number(len(keys)))
	case "call":
		u.call(n, false)
	case "lambda":
		body := u.extra(n)
		for _, capture := range body.Checked.Captures {
			u.load(pos, capture.Index)
		}
		u.emit(pos, "make-closure", ref("body", body.Index), number(len(body.Checked.Captures)))
	case "text-pattern":
		var splices []*syntax.Node
		template := patternDisplay(n, &splices)
		for _, splice := range splices {
			u.expression(splice)
		}
		if len(splices) == 0 {
			u.value(pos, template)
		} else {
			u.emit(pos, "make-pattern", u.constant(template), number(len(splices)))
		}
	case "build":
		u.build(n)
	case "match-all":
		u.expression(n.Children[0])
		u.expression(n.Children[1])
		u.emit(pos, "match-all")
	case "replace-expression":
		u.expression(n.Children[0])
		u.expression(n.Children[1])
		u.replace(n)
	default:
		panic("unhandled expression " + n.Kind)
	}
}

// whose lowers `every K of x whose c`, or `the o K of x whose c` (chapter 8,
// Whose Clauses): a walk over `the Ks of x` that keeps the chunks where `c`
// holds. Its head is an ordinal chunk, perhaps delimited, whose ordinal is
// `every` for an Every Head.
func (u *Unit) whose(n *syntax.Node) {
	at, word := n.Pos(), n.NameToken.Pos
	head := n.Children[0]
	var delimiter *syntax.Node
	if head.Kind == "delimited" {
		head, delimiter = head.Children[0], head.Children[1]
	}
	ordinal, src := head.Children[0].Text, head.Children[1]
	index := slices.Index(generated.Grammar.Ordinals, ordinal) + 1
	if ordinal == "last" {
		index = -1
	}
	r := u.temp()
	if ordinal == "every" {
		u.emit(at, "list", number(0))
	} else {
		u.value(at, "nothing")
	}
	u.store(at, r)
	k := -1
	if index > 1 {
		u.value(word, strconv.Itoa(index))
		k = u.temp()
		u.store(at, k)
	}
	plural := ""
	for _, c := range generated.Grammar.Chunk {
		if c.Singular == n.Text {
			plural = c.Plural
		}
	}
	d := -1
	if delimiter != nil && src.Kind == "chunk" {
		d = u.chunk(src, delimiter, true)
		u.load(at, d)
		u.emit(word, "property-delimited", text(plural))
	} else {
		u.expression(src)
		if delimiter != nil {
			u.expression(delimiter)
			u.emit(word, "property-delimited", text(plural))
		} else {
			u.emit(word, "property", text(plural))
		}
	}
	u.emit(at, "iterate")
	u.state.iterators++
	top, done := &label{}, &label{}
	u.mark(top)
	u.emit(at, "next", target(done))
	t := u.temp()
	u.store(at, t)
	u.state.whoseIt = append(u.state.whoseIt, t)
	u.expression(n.Children[1])
	u.state.whoseIt = u.state.whoseIt[:len(u.state.whoseIt)-1]
	u.emit(at, "branch-false", target(top))
	switch {
	case ordinal == "every":
		u.load(at, r)
		u.load(at, t)
		u.emit(at, "list-append")
		u.store(at, r)
		u.emit(at, "jump", target(top))
	default:
		if k >= 0 {
			u.load(at, k)
			u.value(at, "1")
			u.emit(at, "subtract")
			u.store(at, k)
			u.load(at, k)
			u.value(at, "0")
			u.emit(at, "equal")
			u.emit(at, "branch-false", target(top))
		}
		u.load(at, t)
		u.store(at, r)
		if ordinal == "last" {
			u.emit(at, "jump", target(top))
		} else {
			u.emit(at, "jump", target(done))
		}
	}
	u.mark(done)
	u.emit(at, "pop")
	u.state.iterators--
	u.load(at, r)
	for _, slot := range []int{r, t, k, d} {
		if slot >= 0 {
			u.release(slot)
		}
	}
}

// chunk reads a Chunk Expression. With keep, the delimiter's temp outlives
// the read and is returned, for a Whose Clause's walk.
func (u *Unit) chunk(n, delimiter *syntax.Node, keep bool) int {
	levels := []*syntax.Node{}
	whole := n
	for whole.Kind == "chunk" {
		levels = append(levels, whole)
		u.expression(whole.Children[0])
		whole = whole.Children[1]
	}
	u.expression(whole)
	slot := -1
	if delimiter != nil {
		u.expression(delimiter)
		slot = u.temp()
		u.store(n.Pos(), slot)
	}
	for i := len(levels) - 1; i >= 0; i-- {
		level := levels[i]
		if slot >= 0 && level.Text == "item" {
			u.load(level.Pos(), slot)
			u.emit(level.Pos(), "chunk-get-delimited", text("item"))
		} else {
			u.emit(level.Pos(), "chunk-get", text(level.Text))
		}
	}
	if slot >= 0 && !keep {
		u.release(slot)
	}
	return slot
}
func (u *Unit) call(n *syntax.Node, wait bool) {
	s, ok := u.checked.Resolve(u.state.body.Checked, n.Text)
	if !ok {
		s.Kind = "handler"
		s.Name = n.Text
	}
	op := "call-value"
	args := []operand{}
	switch s.Kind {
	case "function":
		if s.Import != "" {
			op = "call-import"
			args = append(args, text(s.Import))
		} else {
			op = "call"
			args = append(args, ref("body", u.byNode[s.Node].Index))
		}
	case "handler":
		op = "call-handler"
		name := n.Text
		if s.Import != "" {
			name = s.Import
		}
		args = append(args, text(name))
	case "builtin":
		op = "call-builtin"
		args = append(args, text(n.Text))
	default:
		u.named(n, false, n.Pos())
		if wait {
			op = "call-value-wait"
		}
	}
	for _, arg := range n.Children {
		u.expression(arg)
	}
	args = append(args, number(len(n.Children)))
	u.emit(n.Pos(), op, args...)
}
func patternDisplay(n *syntax.Node, splices *[]*syntax.Node) string {
	child := func(i int) string { return patternDisplay(n.Children[i], splices) }
	// Suffixes are idempotent and print in a fixed order, independent of parse nesting.
	if n.Kind == "pattern-lazy" || n.Kind == "pattern-fold" || n.Kind == "pattern-convert" {
		base := n
		fold, lazy, convert := false, false, false
		for base.Kind == "pattern-lazy" || base.Kind == "pattern-fold" || base.Kind == "pattern-convert" {
			switch base.Kind {
			case "pattern-lazy":
				lazy = true
			case "pattern-fold":
				fold = true
			case "pattern-convert":
				convert = true
			}
			base = base.Children[0]
		}
		value := patternDisplay(base, splices)
		if convert {
			value += " as number"
		}
		if fold {
			value += " ignoring case"
		}
		if lazy {
			value += " lazily"
		}
		return value
	}
	switch n.Kind {
	case "text-pattern":
		elements := []string{}

		for _, e := range n.Children {
			value := patternDisplay(e, splices)
			if value != "<>" {
				elements = append(elements, value)
			}
		}
		inside := strings.Join(elements, ", ")
		if strings.HasPrefix(inside, "<") {
			inside = " " + inside
		}
		return "<" + inside + ">"
	case "pattern-text":
		value := quote(n.Text)
		if value != `"`+n.Text+`"` {
			value = "(" + value + ")"
		}
		return value
	case "capture":
		return n.Text + ": " + child(0)
	case "pattern-or":
		return child(0) + " or " + child(1)
	case "pattern-count":
		return literal(n) + " " + child(0)
	case "pattern-repeat":
		return n.Text + " " + child(0)
	case "pattern-convert":
		return child(0) + " as " + n.Children[1].Text
	case "pattern-lazy":
		return child(0) + " lazily"
	case "pattern-fold":
		return child(0) + " ignoring case"
	case "pattern-typed":
		return "a " + n.Children[0].Text
	case "splice":
		*splices = append(*splices, n.Children[0])
		return "(" + strconv.Itoa(len(*splices)) + ")"
	default:
		return n.Text
	}
}
func (u *Unit) build(n *syntax.Node) {
	u.value(n.Pos(), "<<>>")
	for i := 0; i < len(n.Children); i++ {
		field := n.Children[i]
		if field.Text == "bits" {
			widths := []string{}
			first := field
			for i < len(n.Children) && n.Children[i].Text == "bits" {
				f := n.Children[i]
				u.expression(f.Children[0])
				widths = append(widths, f.Children[1].Text)
				i++
			}
			i--
			u.emit(first.Pos(), "bytes-bits", u.constant("["+strings.Join(widths, ", ")+"]"), number(len(widths)))
		} else {
			u.expression(field.Children[0])
			if len(field.Children) > 1 {
				if field.Children[1].Kind == "literal" {
					u.value(field.Pos(), literal(field.Children[1]))
				} else {
					u.expression(field.Children[1])
				}
				u.emit(field.Pos(), "bytes-sized", text(field.Text))
			} else {
				u.emit(field.Pos(), "bytes-field", text(field.Text))
			}
		}
	}
}

// Binary expression actions preserve left-to-right evaluation and short-circuit
// labels without recursive calls for long operator chains (including ^).
func (u *Unit) binaryExpression(n *syntax.Node) {
	type action struct {
		node       *syntax.Node
		stage      uint8
		short, end *label
	}
	stack := []action{{node: n}}
	for len(stack) > 0 {
		a := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		n, pos := a.node, a.node.Pos()
		switch a.stage {
		case 0:
			if n.Kind != "binary" {
				u.expression(n)
			} else {
				stack = append(stack, action{node: n, stage: 1}, action{node: n.Children[0]})
			}
		case 1:
			if n.Text == "and" || n.Text == "or" {
				short, end := &label{}, &label{}
				branch := "branch-false"
				if n.Text == "or" {
					branch = "branch-true"
				}
				u.emit(pos, branch, target(short))
				stack = append(stack, action{node: n, stage: 2, short: short, end: end}, action{node: n.Children[1]})
			} else {
				stack = append(stack, action{node: n, stage: 3}, action{node: n.Children[1]})
			}
		case 2:
			u.emit(pos, "check-boolean")
			u.emit(pos, "jump", target(a.end))
			u.mark(a.short)
			value := "false"
			if n.Text == "or" {
				value = "true"
			}
			u.value(pos, value)
			u.mark(a.end)
		case 3:
			args := []operand{}
			if len(n.Flags) > 0 {
				args = append(args, text("fold"))
			}
			u.emit(pos, binaryOps[n.Text], args...)
			if strings.HasPrefix(n.Text, "is not ") || strings.HasPrefix(n.Text, "does not ") {
				u.emit(pos, "not")
			}
		}
	}
}
