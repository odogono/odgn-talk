// Package lower implements chapter 8's normative lowering. The representation
// is private to the Go Core; only canonical disassembly is shared across Cores.
package lower

import (
	"fmt"
	"github.com/odogono/odgn-talk/impl/go/internal/check"
	"github.com/odogono/odgn-talk/impl/go/internal/generated"
	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
	"slices"
	"strconv"
	"strings"
)

type label struct{ pc int }
type operand struct {
	text, kind string
	index      int
	target     *label
}

func text(s string) operand          { return operand{text: s} }
func number(i int) operand           { return operand{text: strconv.Itoa(i)} }
func ref(kind string, i int) operand { return operand{kind: kind, index: i} }
func target(l *label) operand        { return operand{kind: "label", target: l} }

type Instruction struct {
	Name string
	Pos  syntax.Position
	args []operand
}
type unwind struct {
	first, last int
	kind        string
	target      *label
	depth       int
}
type Body struct {
	Checked *check.Body
	Code    []Instruction
	Unwind  []unwind
	First   int
	Clause  int
	Index   int
}
type eventBranch struct {
	message  string
	from     bool
	body     int
	captures int
	binds    []int
	after    bool
}
type event struct {
	branches []eventBranch
	timeout  bool
}
type Unit struct {
	Name, Kind                                 string
	Constants, Definitions, Variables, Objects []string
	Bodies                                     []*Body
	Events                                     []event
	checked                                    *check.Unit
	byNode                                     map[*syntax.Node]*Body
	state                                      *builder
}
type loop struct {
	start, end *label
	finally    int
	iterator   bool
}
type finalizer struct {
	scope int
	node  *syntax.Node
}
type builder struct {
	regions   []*region
	body      *Body
	temps     []bool
	overrides map[string]int
	loops     []loop
	finally   []*finalizer
	join      int
	moves     []bindingMove
}

func (u *Unit) emit(pos syntax.Position, name string, args ...operand) {
	u.state.body.Code = append(u.state.body.Code, Instruction{name, pos, args})
}
func (u *Unit) pc() int       { return len(u.state.body.Code) }
func (u *Unit) mark(l *label) { l.pc = u.pc() }
func (u *Unit) temp() int {
	for i, used := range u.state.temps {
		if !used {
			u.state.temps[i] = true
			return len(u.state.body.Checked.Locals) - len(u.state.temps) + i
		}
	}
	i := len(u.state.body.Checked.Locals)
	u.state.temps = append(u.state.temps, true)
	u.state.body.Checked.Locals = append(u.state.body.Checked.Locals, fmt.Sprintf("(%d)", i))
	return i
}
func (u *Unit) release(slot int) {
	base := len(u.state.body.Checked.Locals) - len(u.state.temps)
	u.state.temps[slot-base] = false
}
func (u *Unit) constant(value string) operand {
	i := slices.Index(u.Constants, value)
	if i < 0 {
		i = len(u.Constants)
		u.Constants = append(u.Constants, value)
	}
	return ref("constant", i)
}
func (u *Unit) value(pos syntax.Position, value string) { u.emit(pos, "const", u.constant(value)) }
func (u *Unit) load(pos syntax.Position, slot int)      { u.emit(pos, "load", ref("local", slot)) }
func (u *Unit) store(pos syntax.Position, slot int)     { u.emit(pos, "store", ref("local", slot)) }
func (u *Unit) named(n *syntax.Node, store bool, pos syntax.Position) {
	if slot, ok := u.state.overrides[n.Text]; ok && n.Kind != "pin" {
		if store {
			u.store(pos, slot)
		} else {
			u.load(pos, slot)
		}
		return
	}
	s, ok := u.checked.Resolve(u.state.body.Checked, n.Text)
	if !ok {
		s = check.Symbol{Kind: "object", Name: n.Text}
	}
	switch s.Kind {
	case "local":
		if store {
			u.store(pos, s.Index)
		} else {
			u.load(pos, s.Index)
		}
	case "variable":
		op := "load-var"
		if store {
			op = "store-var"
		}
		u.emit(pos, op, ref("variable", s.Index))
	case "definition":
		op := "load-definition"
		if store {
			op = "store-definition"
		}
		name := s.Name
		if s.Import != "" {
			name = s.Import
		}
		u.emit(pos, op, text(name))
	case "function":
		if s.Import != "" {
			u.emit(pos, "make-imported-function", text(s.Import))
		} else {
			u.emit(pos, "make-function", ref("body", u.byNode[s.Node].Index))
		}
	case "builtin-constant":
		u.value(pos, n.Text)
	default:
		if !slices.Contains(u.Objects, n.Text) {
			u.Objects = append(u.Objects, n.Text)
		}
		u.emit(pos, "load-object", text(n.Text))
	}
}

// Compile accepts only a diagnostic-free checked unit. Temporary slots belong
// to this compilation; compiling it again does not mutate its semantic form.
func Compile(checked *check.Unit, name string) (*Unit, error) {
	if len(checked.Diagnostics) != 0 {
		return nil, fmt.Errorf("cannot lower rejected unit: %v", checked.Diagnostics)
	}
	u := &Unit{Name: name, Kind: "script", checked: checked, Definitions: checked.Definitions, Variables: checked.Variables, byNode: map[*syntax.Node]*Body{}}
	if checked.Options.Library {
		u.Kind = "library"
	}
	initNode := &syntax.Node{Kind: "init", Token: syntax.Token{Pos: syntax.Position{Line: 1, Column: 1}}, End: syntax.Token{Pos: syntax.Position{Line: 1, Column: 1}}}
	initial := &check.Body{Node: initNode, Kind: "init", Name: "initialiser", Locals: []string{"it"}}
	u.Bodies = append(u.Bodies, &Body{Checked: initial, Index: 0})
	u.byNode[initNode] = u.Bodies[0]
	clauses := map[string]int{}
	for _, n := range checked.Tree.Declarations {
		if b := checked.Bodies[n]; b != nil {
			lowered := &Body{Checked: cloneBody(b), Index: len(u.Bodies)}
			if b.Kind == "handler" {
				clauses[b.Name]++
				lowered.Clause = clauses[b.Name]
			}
			u.Bodies = append(u.Bodies, lowered)
			u.byNode[n] = lowered
		}
	}
	u.state = &builder{body: u.Bodies[0], overrides: map[string]int{}}
	for _, n := range checked.Tree.Declarations {
		switch n.Kind {
		case "variable", "constant":
			if len(n.Children) > 0 {
				u.expression(n.Children[0])
			} else {
				u.value(n.Pos(), "nothing")
			}
			root := &syntax.Node{Text: n.Text}
			u.named(root, true, n.Pos())
		case "function":
			for _, p := range n.Params {
				if len(p.Children) > 0 {
					u.expression(p.Children[0])
					u.emit(p.Pos(), "store-definition", text(n.Text+"."+p.Text))
				}
			}
		}
	}
	u.value(initNode.Pos(), "nothing")
	u.emit(initNode.Pos(), "return")
	for _, n := range checked.Tree.Declarations {
		if b := u.byNode[n]; b != nil {
			u.compileBody(b)
		}
	}
	pc := 0
	for _, body := range u.Bodies {
		for _, instruction := range body.Code {
			for _, opcode := range generated.Machine.Instruction {
				if opcode.Name == instruction.Name && opcode.Suspends {
					body.Checked.MaySuspend = true
				}
			}
		}
		body.First = pc
		pc += len(body.Code)
	}
	return u, nil
}
func cloneBody(b *check.Body) *check.Body {
	c := *b
	c.Locals = slices.Clone(b.Locals)
	return &c
}
func (u *Unit) extra(n *syntax.Node) *Body {
	if body := u.byNode[n]; body != nil {
		return body
	}
	b := u.checked.Bodies[n]
	if b == nil {
		panic(fmt.Sprintf("missing checked body at %v", n.Pos()))
	}
	body := &Body{Checked: cloneBody(b), Index: len(u.Bodies)}
	u.Bodies = append(u.Bodies, body)
	u.byNode[n] = body
	u.compileBody(body)
	return body
}
func (u *Unit) compileBody(body *Body) {
	parent := u.state
	u.state = &builder{body: body, overrides: map[string]int{}}
	defer func() { u.state = parent }()
	n := body.Checked.Node
	fail := &label{}
	direct := body.Checked.Kind != "function"
	start := u.pc()
	if direct {
		for i, p := range n.Params {
			if body.Checked.Kind == "handler" && body.Checked.Name == "error" {
				p = errorPattern(p)
			}
			if p.Kind != "binding" {
				u.pattern(p, i+1, fail, true, false)
			}
		}
	}
	if n.Guard != nil {
		u.expression(n.Guard)
		u.emit(n.Guard.FirstPos(), "branch-false", target(fail))
	}
	if end := u.pc(); end > start && (body.Checked.Kind == "handler" || body.Checked.Kind == "event") {
		body.Unwind = append(body.Unwind, unwind{start, end - 1, "guard", fail, 0})
	}
	if body.Checked.Kind == "event" {
		bindings := []*syntax.Node{}
		for _, p := range n.Params {
			bindings = append(bindings, check.Bindings(p)...)
		}
		for _, binding := range bindings {
			u.named(binding, false, n.Pos())
		}
		u.emit(n.Pos(), "list", number(len(bindings)))
		u.emit(n.Pos(), "return")
		u.mark(fail)
		u.emit(n.Pos(), "clause-fail")
		return
	}
	if body.Checked.Kind == "lambda" && len(n.Children) > 0 {
		u.expression(n.Children[0])
		u.emit(n.Pos(), "return")
	} else {
		if len(n.Branches) > 0 && n.Branches[len(n.Branches)-1].Kind == "finally" {
			try := &syntax.Node{Kind: "try", Token: n.Branches[len(n.Branches)-1].Token, Body: n.Body, Branches: n.Branches}
			u.tryStatement(try)
		} else {
			u.statements(n.Body)
		}
		u.value(n.End.Pos, "nothing")
		u.emit(n.End.Pos, "return")
	}
	u.mark(fail)
	if body.Checked.Kind == "handler" {
		u.emit(n.End.Pos, "clause-fail")
	} else if body.Checked.Kind == "lambda" && u.hasPatternParams(n) {
		u.emit(n.Pos(), "raise", text("no match"))
	}
}
func (u *Unit) hasPatternParams(n *syntax.Node) bool {
	for _, p := range n.Params {
		if p.Kind != "binding" {
			return true
		}
	}
	return false
}
func (u *Unit) depth() int {
	n := 0
	for _, loop := range u.state.loops {
		if loop.iterator {
			n++
		}
	}
	return n
}
func (u *Unit) operands(body *Body, args []operand) ([]string, []string) {
	shown, notes := []string{}, []string{}
	for _, arg := range args {
		switch arg.kind {
		case "label":
			shown = append(shown, fmt.Sprintf("%04d", body.First+arg.target.pc))
		case "local":
			shown = append(shown, strconv.Itoa(arg.index))
			notes = append(notes, body.Checked.Locals[arg.index])
		case "constant":
			shown = append(shown, strconv.Itoa(arg.index))
			notes = append(notes, u.Constants[arg.index])
		case "variable":
			shown = append(shown, strconv.Itoa(arg.index))
			notes = append(notes, u.Variables[arg.index])
		case "body":
			shown = append(shown, strconv.Itoa(arg.index))
			notes = append(notes, u.Bodies[arg.index].Checked.Name)
		default:
			shown = append(shown, arg.text)
		}
	}
	return shown, notes
}
func (u *Unit) Disassemble() string {
	var out strings.Builder
	fmt.Fprintf(&out, "unit %s %s\n", u.Name, u.Kind)
	for _, section := range []struct {
		name   string
		values []string
	}{{"constants", u.Constants}, {"definitions", u.Definitions}, {"variables", u.Variables}, {"objects", u.Objects}} {
		if len(section.values) > 0 {
			fmt.Fprintln(&out, section.name)
			for i, value := range section.values {
				fmt.Fprintf(&out, "  %d %s\n", i, value)
			}
		}
	}
	fmt.Fprintln(&out, "bodies")
	for _, body := range u.Bodies {
		b := body.Checked
		fmt.Fprintf(&out, "  %d %s %s", body.Index, b.Kind, b.Name)
		if body.Clause > 0 {
			fmt.Fprintf(&out, " clause %d", body.Clause)
		}
		params := []string{}
		for _, p := range b.Node.Params {
			if p.Kind == "name" || p.Kind == "binding" {
				param := p.Text
				if b.Kind == "function" && len(p.Children) > 0 {
					param += fmt.Sprintf(" = %d", slices.Index(u.Definitions, b.Name+"."+p.Text))
				}
				params = append(params, param)
			} else {
				params = append(params, "…")
			}
		}
		fmt.Fprintf(&out, " (%s)", strings.Join(params, ", "))
		if len(b.Captures) > 0 {
			fmt.Fprintf(&out, " captures %d", len(b.Captures))
		}
		fmt.Fprintf(&out, " locals %d", len(b.Locals))
		suspends := b.MaySuspend
		for _, ins := range body.Code {
			for _, op := range generated.Machine.Instruction {
				if ins.Name == op.Name && op.Suspends {
					suspends = true
				}
			}
		}
		if suspends {
			fmt.Fprint(&out, " may suspend")
		}
		fmt.Fprintf(&out, " %04d..%04d\n", body.First, body.First+len(body.Code)-1)
	}
	fmt.Fprintln(&out, "code")
	for _, body := range u.Bodies {
		for i, ins := range body.Code {
			fmt.Fprintf(&out, "  %04d %d:%d %s", body.First+i, ins.Pos.Line, ins.Pos.Column, ins.Name)
			args, notes := u.operands(body, ins.args)
			if len(args) > 0 {
				fmt.Fprint(&out, " "+strings.Join(args, " "))
			}
			if len(notes) > 0 {
				fmt.Fprint(&out, " ; "+strings.Join(notes, ", "))
			}
			fmt.Fprintln(&out)
		}
	}
	unwinds := 0
	for _, b := range u.Bodies {
		unwinds += len(b.Unwind)
	}
	if unwinds > 0 {
		fmt.Fprintln(&out, "unwind")
		for _, b := range u.Bodies {
			for _, entry := range b.Unwind {
				fmt.Fprintf(&out, "  %04d..%04d %s -> %04d depth %d\n", b.First+entry.first, b.First+entry.last, entry.kind, b.First+entry.target.pc, entry.depth)
			}
		}
	}
	if len(u.Events) > 0 {
		fmt.Fprintln(&out, "events")
		for i, event := range u.Events {
			branches := []string{}
			for _, b := range event.branches {
				if b.after {
					branches = append(branches, "after")
					continue
				}
				s := "when " + b.message
				if b.from {
					s += " from"
				}
				if b.body >= 0 {
					s += fmt.Sprintf(" body %d", b.body)
				}
				if b.captures > 0 {
					s += fmt.Sprintf(" captures %d", b.captures)
				}
				if len(b.binds) > 0 {
					items := []string{}
					for _, slot := range b.binds {
						items = append(items, strconv.Itoa(slot))
					}
					s += " binds " + strings.Join(items, ", ")
				}
				branches = append(branches, s)
			}
			if event.timeout {
				branches = append(branches, "or")
			}
			fmt.Fprintf(&out, "  %d %s\n", i, strings.Join(branches, "; "))
		}
	}
	return out.String()
}
