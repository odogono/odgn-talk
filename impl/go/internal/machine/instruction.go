package machine

import (
	"math/big"
	"slices"
	"strings"

	"github.com/odogono/odgn-talk/impl/go/internal/decimal"
	"github.com/odogono/odgn-talk/impl/go/internal/generated"
	"github.com/odogono/odgn-talk/impl/go/internal/lower"
	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
	coreunicode "github.com/odogono/odgn-talk/impl/go/internal/unicode"
	"github.com/odogono/odgn-talk/impl/go/internal/value"
)

func text(s string) value.Value   { v, _ := value.NewText(s); return v }
func integer(n int64) value.Value { return value.Value{Kind: value.Number, Number: decimal.FromInt(n)} }
func boolean(b bool) value.Value  { return value.Value{Kind: value.Boolean, Bool: b} }
func failure(code string, fields ...value.Pair) value.Value {
	message := code
	for _, entry := range generated.Errors.Error {
		if entry.Code != code {
			continue
		}
		message = entry.Message
		var replacements []string
		for _, field := range fields {
			replacements = append(replacements, "{"+field.Key+"}", field.Val.Display())
		}
		if len(replacements) > 0 {
			message = strings.NewReplacer(replacements...).Replace(message)
		}
		break
	}
	v, _ := value.NewMap(append([]value.Pair{{Key: "code", Val: text(code)}, {Key: "message", Val: text(message)}}, fields...))
	v.CoreMessage = true
	return v
}
func wrong(expected string, v value.Value) value.Value {
	return failure("wrong kind", value.Pair{Key: "expected", Val: text(expected)}, value.Pair{Key: "got", Val: text(value.KindNames[v.Kind])}, value.Pair{Key: "value", Val: v})
}
func constant(s string) (value.Value, error) {
	switch s {
	case "newline":
		return text("\n"), nil
	case "tab":
		return text("\t"), nil
	case "quote":
		return text("\""), nil
	case "space":
		return text(" "), nil
	case "empty":
		return text(""), nil
	case "pi":
		n, _ := decimal.Parse("3.141592653589793238462643383279503")
		return value.Value{Kind: value.Number, Number: n}, nil
	}
	if strings.HasPrefix(s, "<") && !strings.HasPrefix(s, "<<") {
		return value.Value{Kind: value.Pattern, Text: s}, nil
	}
	r := value.Reader{Text: s}
	v, e := r.Value()
	if e != nil {
		return v, e
	}
	return v, nil
}
func (r *Run) evaluate(f *Frame, i lower.Instruction) (Measures, func(), *value.Value) {
	code := f.Code
	m := Measures{}
	args := i.Operands()
	idx := func(n int) int { return args[n].Index }
	name := func(n int) string { return args[n].Text }
	pop := func() value.Value {
		v := f.Stack[len(f.Stack)-1]
		delete(f.ReceiverNames, len(f.Stack)-1)
		f.Stack = f.Stack[:len(f.Stack)-1]
		return v
	}
	push := func(v value.Value) {
		f.Stack = append(f.Stack, v)
		m.Result = v
		m.ResultPresent = true
	}
	take := func(n int) []value.Value {
		vs := slices.Clone(f.Stack[len(f.Stack)-n:])
		f.Stack = f.Stack[:len(f.Stack)-n]
		for slot := range f.ReceiverNames {
			if slot >= len(f.Stack) {
				delete(f.ReceiverNames, slot)
			}
		}
		return vs
	}
	jump := func() { f.PC = args[len(args)-1].Index - 1 }
	receiver := func(name string) {
		push(value.Value{})
		if f.ReceiverNames == nil {
			f.ReceiverNames = map[int]string{}
		}
		f.ReceiverNames[len(f.Stack)-1] = name
	}
	var effect func()
	var err *value.Value
	bad := func(v value.Value) { err = &v }
	key := func(s string) string {
		v, e := constant(s)
		if e == nil && v.Kind == value.Text {
			return v.Text
		}
		return s
	}
	switch i.Name {
	case "const":
		push(code.Constants[idx(0)])
	case "pop":
		pop()
	case "load":
		push(f.Locals[idx(0)])
	case "store":
		f.Locals[idx(0)] = pop()
	case "move":
		f.Locals[idx(1)] = f.Locals[idx(0)]
	case "load-var":
		push(r.State.Variables[idx(0)])
	case "store-var":
		v := pop()
		slot := idx(0)
		effect = func() { r.State.Variables[slot] = v }
	case "load-definition":
		definition := name(0)
		if library, exported, ok := strings.Cut(definition, ":"); ok {
			lib := code.Libraries[library]
			push(BindLibraryValue(lib.Definitions[slices.Index(lib.Unit.Definitions, exported)], r.State))
		} else {
			push(BindLibraryValue(code.Definitions[slices.Index(code.Unit.Definitions, definition)], r.State))
		}
	case "store-definition":
		v := pop()
		slot := slices.Index(code.Unit.Definitions, name(0))
		effect = func() { code.Definitions[slot] = v }
	case "load-object":
		if v, ok := r.State.Objects[name(0)]; ok {
			push(v)
		} else if next := code.Unit.Bodies[f.Body].Code[f.PC+1].Name; slices.Contains(r.State.ScriptNames, name(0)) || namedSend(next) || spreadSend(next) {
			// A computed name is checked first, so its send raises `object gone`.
			receiver(name(0))
		} else {
			bad(failure("object gone", value.Pair{Key: "object", Val: text(name(0))}))
		}
	case "me":
		next := code.Unit.Bodies[f.Body].Code[f.PC+1].Name
		if r.State.Me.Kind == value.Nothing && (next == "send" || next == "send-wait" || next == "join-send" || namedSend(next) || spreadSend(next)) {
			receiver(r.State.Unit.Name)
		} else {
			push(r.State.Me)
		}
	case "join-start":
		effect = func() { r.Join = &Join{Frame: len(r.Frames) - 1, Start: r.Frames[len(r.Frames)-1].PC - 1} }
	case "join-end":
		if len(r.Join.Members) == 0 {
			m.Result = value.NewList(nil)
			push(m.Result)
			effect = func() { r.Join = nil }
		} else {
			effect = func() { r.Status = Suspended }
		}
	case "send", "send-wait", "join-send", "send-named", "send-named-wait", "join-send-named", "send-spread", "send-spread-wait", "join-send-spread", "send-up", "send-up-wait":
		n := 0
		if spreadSend(i.Name) {
			// The name, the argument list and the receiver: the name is
			// checked against the list's length, before the receiver
			// (chapter 5, A spread; ADR 0064).
			list, v := f.Stack[len(f.Stack)-2], f.Stack[len(f.Stack)-3]
			n = len(list.Items)
			if v.Kind != value.Text {
				bad(wrong("text", v))
				break
			} else if !syntax.ValidComputedMessageName(v.Text, n) {
				bad(failure("bad message name", value.Pair{Key: "name", Val: v}, value.Pair{Key: "arguments", Val: integer(int64(n))}))
				break
			}
		} else if namedSend(i.Name) {
			// A computed name, below the arguments, is checked before the
			// receiver (chapter 5, A computed name).
			n = idx(0)
			if v := f.Stack[len(f.Stack)-n-2]; v.Kind != value.Text {
				bad(wrong("text", v))
				break
			} else if !syntax.ValidComputedMessageName(v.Text, n) {
				bad(failure("bad message name", value.Pair{Key: "name", Val: v}, value.Pair{Key: "arguments", Val: integer(int64(n))}))
				break
			}
		} else {
			n = idx(1)
		}
		if i.Name != "send-up" && i.Name != "send-up-wait" {
			name := f.ReceiverNames[len(f.Stack)-1]
			v := pop()
			if name == "" && v.Kind != value.Object {
				bad(wrong("object", v))
				break
			}
			if (namedSend(i.Name) || spreadSend(i.Name)) && name != "" && !slices.Contains(r.State.ScriptNames, name) {
				bad(failure("object gone", value.Pair{Key: "object", Val: text(name)}))
				break
			}
			if v.Kind == value.Object && v.Object.Disposed != nil && v.Object.Disposed.Load() {
				bad(failure("object gone", value.Pair{Key: "object", Val: v}))
				break
			}
		}
		if spreadSend(i.Name) {
			m.Args = slices.Clone(pop().Items)
		} else {
			m.Args = take(n)
		}
		if namedSend(i.Name) || spreadSend(i.Name) {
			pop()
		}
		m.InputSize = 32
		for _, v := range m.Args {
			m.InputSize = saturatingAdd(m.InputSize, Size(v))
		}
		if i.Name == "send-wait" || i.Name == "send-named-wait" || i.Name == "send-spread-wait" || i.Name == "send-up-wait" {
			effect = func() { r.SendWait = true; r.Status = Suspended }
		}
	case "target":
		push(r.Target)
	case "jump":
		jump()
	case "branch-false", "branch-true", "check-boolean", "not":
		v := pop()
		if v.Kind != value.Boolean {
			bad(wrong("boolean", v))
			break
		}
		switch i.Name {
		case "branch-false":
			if !v.Bool {
				jump()
			}
		case "branch-true":
			if v.Bool {
				jump()
			}
		case "not":
			push(boolean(!v.Bool))
		default:
			push(v)
		}
	case "pass":
		effect = func() { r.setFrames(nil); r.Passed = true; r.Status = Completed }
	case "return", "veto":
		v := pop()
		effect = func() {
			retired := r.popFrame()
			clear(retired.Stack[:cap(retired.Stack)])
			clear(retired.Locals[:cap(retired.Locals)])
			r.spareFrames = append(r.spareFrames, Frame{Stack: retired.Stack[:0], Locals: retired.Locals[:0]})
			if len(r.Frames) == 0 {
				if i.Name == "veto" {
					r.Vetoed, r.VetoReason = true, v
					r.Result = value.Value{}
				} else {
					r.Result = v
				}
				r.Status = Completed
			} else {
				caller := &r.Frames[len(r.Frames)-1]
				caller.Stack = append(caller.Stack, v)
				caller.Waiting = false
			}
		}
	case "call", "call-import":
		callee, body, n := code, idx(0), idx(1)
		if i.Name == "call-import" {
			library, exported, _ := strings.Cut(name(0), ":")
			callee = code.Libraries[library]
			for _, b := range callee.Unit.Bodies {
				if b.Checked.Kind == "function" && b.Checked.Name == exported {
					body = b.Index
					break
				}
			}
		}
		m.Count = int64(n)
		vs := take(n)
		f.Waiting = true
		b := callee.Unit.Bodies[body]
		for j := n; j < len(b.Checked.Node.Params); j++ {
			param := b.Checked.Node.Params[j]
			slot := slices.Index(callee.Unit.Definitions, b.Checked.Name+"."+param.Text)
			vs = append(vs, BindLibraryValue(callee.Definitions[slot], r.State))
		}
		effect = func() { r.pushCodeFrame(callee, body, vs) }
	case "call-handler", "call-handler-wait":
		n := idx(1)
		vs := take(n)
		m.Count = int64(n)
		callee, handler := code, name(0)
		if library, exported, ok := strings.Cut(handler, ":"); ok && code.Unit.Checked().Symbols[handler].Kind != "handler" {
			callee, handler = code.Libraries[library], exported
		}
		bodies := []int{}
		for _, b := range callee.Unit.Bodies {
			if b.Checked.Kind == "handler" && b.Checked.Name == handler && len(b.Checked.Node.Params) == n {
				bodies = append(bodies, b.Index)
			}
		}
		if len(bodies) == 0 {
			bad(failure("no match"))
			break
		}
		f.Waiting = true
		effect = func() {
			r.pushCodeFrame(callee, bodies[0], vs)
			r.Frames[len(r.Frames)-1].Dispatch = &handlerDispatch{Bodies: bodies[1:], Args: vs}
		}
	case "make-function", "make-closure", "make-imported-function":
		callee, bodyIndex := code, idx(0)
		if i.Name == "make-imported-function" {
			library, exported, _ := strings.Cut(name(0), ":")
			callee = code.Libraries[library]
			for _, b := range callee.Unit.Bodies {
				if b.Checked.Kind == "function" && b.Checked.Name == exported {
					bodyIndex = b.Index
					break
				}
			}
		}
		body := callee.Unit.Bodies[bodyIndex]
		captures := []value.Pair{}
		if i.Name == "make-closure" {
			m.Count = int64(idx(1))
			vs := take(idx(1))
			for j, v := range vs {
				captures = append(captures, value.Pair{Key: body.Checked.Captures[j].Name, Val: v})
			}
		}
		functionName := ""
		if body.Checked.Kind == "function" {
			functionName = body.Checked.Name
		}
		required, total := functionArity(body)
		push(value.Value{Kind: value.Function, Function: &value.FunctionData{Home: r.State.Unit.Name, Code: functionCode(callee, body.Index, body.Checked.Name), CodeState: callee, Captures: captures, Body: body.Index, Owner: r.State, Group: r.State.Group, Name: functionName, Required: required, Total: total}})
	case "call-value", "call-value-wait":
		n := idx(0)
		vs := take(n)
		fn := pop()
		m.Count = int64(n)
		if fn.Kind != value.Function {
			bad(wrong("function", fn))
			break
		}
		data := fn.Function
		home, _ := data.Owner.(*State)
		if data.Owner == nil || data.Body < 0 || home != nil && home.Gone {
			bad(failure("function gone"))
			break
		}
		if data.Owner != r.State {
			if i.Name == "call-value" {
				bad(failure("would suspend"))
				break
			}
			// Foreign arity and defaults are checked here before admission.
			_, _, err := functionArguments(fn, vs)
			if err != nil {
				bad(*err)
				break
			}
			m.Args = vs
			effect = func() { r.SendWait = true; r.FunctionWait = true; r.Status = Suspended }
			break
		}
		callee := home
		if unit, ok := data.CodeState.(*State); ok {
			callee = unit
		}
		body := callee.Unit.Bodies[data.Body]
		maySuspend := body.Checked.MaySuspend
		for _, ins := range body.Code {
			if ins.Suspends {
				maySuspend = true
				break
			}
		}
		if maySuspend && i.Name == "call-value" {
			bad(failure("would suspend"))
			break
		}
		callee, vs, err := functionArguments(fn, vs)
		if err != nil {
			bad(*err)
			break
		}
		f.Waiting = true
		effect = func() { r.pushFunction(callee, fn, vs) }

	case "wait":
		ns, err := waitNanos(pop())
		if err != nil {
			bad(*err)
			break
		}
		effect = func() { r.WaitNS = ns; r.Status = Suspended }
	case "wait-for", "wait-for-any":
		entry := code.Unit.Events[idx(0)]
		w, err := r.eventWait(i.Name, entry, take(eventValueCount(entry)))
		if err != nil {
			bad(*err)
			break
		}
		effect = func() { r.EventWait = w; r.Status = Suspended }
	case "call-builtin":
		m.Args = take(idx(1))
		if name(0) == "offerAvailable" {
			v := m.Args[0]
			if v.Kind != value.Text {
				bad(wrong("text", v))
				break
			}
			found := offerLookup{}
			if validOfferName(v.Text) {
				found = r.lookupOffer(v.Text)
			}
			push(boolean(found.Offer != nil))
			effect = func() { r.pay(int64(4*found.Frames), 0) }
			break
		}
		v, e := builtin(name(0), m.Args, &m)
		if e != nil {
			bad(*e)
		} else {
			push(v)
		}
	case "add", "subtract", "multiply", "divide", "div", "mod", "power":
		b, a := pop(), pop()
		op := map[string]string{"add": "+", "subtract": "-", "multiply": "*", "divide": "/", "div": "div", "mod": "mod", "power": "^"}[i.Name]
		v, e := arithmetic(op, a, b)
		if e != nil {
			bad(*e)
		} else {
			push(v)
		}
	case "negate":
		v := pop()
		if v.Kind != value.Number && v.Kind != value.Quantity {
			bad(wrong("number or quantity", v))
		} else {
			v.Number = v.Number.Negate()
			push(v)
		}
	case "concat":
		b, a := pop(), pop()
		push(text(textForm(a) + textForm(b)))
	case "range":
		b, a := pop(), pop()
		if a.Kind != value.Number && a.Kind != value.Quantity {
			bad(wrong("number or quantity", a))
			break
		}
		if b.Kind != value.Number && b.Kind != value.Quantity {
			bad(wrong("number or quantity", b))
			break
		}
		v, e := value.NewRange(a, b)
		if e != nil {
			bad(failure("incompatible units", value.Pair{Key: "left", Val: text(a.Unit.String())}, value.Pair{Key: "right", Val: text(b.Unit.String())}))
		} else {
			push(v)
		}
	case "equal", "not-equal", "less", "greater", "less-or-equal", "greater-or-equal":
		b, a := pop(), pop()
		folded := len(args) > 0
		m.Scanned = compared(a, b, folded)
		if i.Name == "equal" || i.Name == "not-equal" {
			eq := equal(a, b, folded)
			push(boolean(eq == (i.Name == "equal")))
		} else {
			c, e := fold(a).Compare(fold(b))
			if !folded {
				c, e = a.Compare(b)
			}
			if e != nil {
				bad(comparisonError(a, b))
			} else {
				push(boolean(i.Name == "less" && c < 0 || i.Name == "greater" && c > 0 || i.Name == "less-or-equal" && c <= 0 || i.Name == "greater-or-equal" && c >= 0))
			}
		}
	case "is-kind":
		push(boolean(kindTest(pop(), name(0))))
	case "is-empty":
		push(boolean(empty(pop())))
	case "convert", "can-convert":
		m.Input = pop()
		m.InputPresent = true
		v, e := convert(m.Input, name(0))
		if i.Name == "can-convert" {
			push(boolean(e == nil))
		} else if e != nil {
			bad(*e)
		} else {
			push(v)
		}
	case "member":
		b, a := pop(), pop()
		yes, scanned, e := membership(a, b, len(args) > 0)
		m.Scanned = scanned
		if e != nil {
			bad(*e)
		} else {
			push(boolean(yes))
		}
	case "test-key", "test-key-computed", "set-key", "set-key-computed", "delete-key", "delete-key-computed":
		part := value.Value{}
		if strings.HasPrefix(i.Name, "set-key") {
			part = pop()
			m.Input = part
			m.InputPresent = true
		}
		whole := pop()
		k := nameOrEmpty(args)
		if strings.HasSuffix(i.Name, "-computed") {
			v := pop()
			if v.Kind != value.Text {
				bad(wrong("text", v))
				break
			}
			k = v.Text
		} else {
			k = key(k)
		}
		if strings.HasPrefix(i.Name, "test-key") {
			if whole.Kind != value.Map {
				bad(wrong("map", whole))
			} else if !hasKey(whole, k) {
				jump()
			}
			break
		}
		v, e := mapWrite(whole, k, part, strings.HasPrefix(i.Name, "delete-key"))
		if e != nil {
			bad(*e)
		} else {
			push(v)
		}
	case "list":
		n := idx(0)
		m.Count = int64(n)
		push(value.NewList(take(n)))
	case "list-append", "list-extend":
		v, list := pop(), pop()
		if list.Kind != value.List {
			bad(wrong("list", list))
			break
		}
		vs := []value.Value{v}
		if i.Name == "list-extend" {
			if v.Kind != value.List {
				bad(wrong("list", v))
				break
			}
			vs = v.Items
		}
		push(extendList(list, vs, false))
	case "map":
		n := idx(1)
		m.Count = int64(n)
		vs := take(n)
		keys := code.Constants[idx(0)]
		pairs := make([]value.Pair, n)
		for j := range pairs {
			pairs[j] = value.Pair{Key: keys.Items[j].Text, Val: vs[j]}
		}
		v, _ := value.NewMap(pairs)
		push(v)
	case "get-key", "get-key-computed":
		v := pop()
		k := nameOrEmpty(args)
		if i.Name == "get-key-computed" {
			x := pop()
			if x.Kind != value.Text {
				bad(wrong("text", x))
				break
			}
			k = x.Text
		} else {
			k = key(k)
		}
		if v.Kind == value.Object && k == "id" {
			push(text(v.Object.ID))
		} else if v.Kind != value.Map {
			bad(wrong("map", v))
		} else {
			push(v.Get(k))
		}
	case "set-property", "set-property-computed":
		pop() // input
		v := pop()
		if i.Name == "set-property-computed" {
			x := pop()
			if x.Kind != value.Text {
				bad(wrong("text", x))
				break
			}
		}
		bad(wrong("object", v)) // Object writes take the Host crossing path.
	case "property", "property-delimited":
		d := text(",")
		if i.Name == "property-delimited" {
			d = pop()
		}
		v := pop()
		m.Input = v
		m.InputPresent = true
		result, e := property(name(0), v, d)
		if e != nil {
			bad(*e)
		} else {
			push(result)
		}
	case "chunk-get", "chunk-get-delimited", "chunk-set", "chunk-set-delimited", "chunk-delete", "chunk-delete-delimited", "test-chunk", "test-chunk-delimited":
		d := text(",")
		if strings.HasSuffix(i.Name, "-delimited") {
			d = pop()
		}
		part := value.Value{}
		if strings.HasPrefix(i.Name, "chunk-set") {
			part = pop()
		}
		whole, index := pop(), pop()
		result, scanned, exists, e := chunk(i.Name, name(0), index, whole, part, d)
		m.Scanned = scanned
		m.Input = whole
		m.InputPresent = true
		if strings.HasPrefix(i.Name, "chunk-delete") {
			m.Input = value.Value{}
			m.InputPresent = false
		}
		if strings.HasPrefix(i.Name, "chunk-set") {
			m.Input = part
			m.InputPresent = true
		}
		if e != nil {
			bad(*e)
		} else if strings.HasPrefix(i.Name, "test-chunk") {
			m.Result = result
			m.ResultPresent = true
			if !exists {
				jump()
			}
		} else {
			push(result)
		}
	case "bytes-field", "bytes-sized", "bytes-bits", "bin-start", "bin-literal", "bin-int", "bin-bits", "bin-bytes", "bin-rest", "bin-end":
		err = binaryInstruction(f, i, code, &m)
	case "make-pattern":
		n := idx(1)
		vs := take(n)
		source := code.Constants[idx(0)].Text
		for _, v := range vs {
			if v.Kind != value.Text && v.Kind != value.Pattern {
				bad(wrong("pattern", v))
				break
			}
		}
		if err == nil {
			source, e := spliceTemplate(source, vs)
			if e != nil {
				bad(failure("can't convert", value.Pair{Key: "value", Val: text(source)}, value.Pair{Key: "to", Val: text("pattern")}))
				break
			}
			v, e := value.ParsePattern(source)
			if e != nil {
				bad(failure("can't convert", value.Pair{Key: "value", Val: text(source)}, value.Pair{Key: "to", Val: text("pattern")}))
			} else {
				push(v)
			}
		}
	case "match-whole", "match-search":
		needle, subject := pop(), pop()
		if subject.Kind != value.Text {
			jump()
			break
		}
		p, e := compilePattern(needle, len(args) > 1)
		if e != nil {
			bad(wrong("text or pattern", needle))
			break
		}
		mode := "whole"
		if i.Name == "match-search" {
			mode = "search"
		}
		match, steps := search(p, subject.Text, 0, mode, false)
		m.Steps = steps
		if match == nil {
			jump()
		} else {
			v, e := matchValue(p, subject.Text, match)
			if e != nil {
				bad(*e)
			} else {
				push(v.Get("captures"))
			}
		}
	case "replace-start":
		subject, needle := pop(), pop()
		if subject.Kind != value.Text {
			bad(wrong("text", subject))
			break
		}
		p, e := compilePattern(needle, false)
		if e != nil {
			bad(wrong("text or pattern", needle))
			break
		}
		matches := value.NewList(nil)
		if idx(0) == 1 {
			match, steps := search(p, subject.Text, 0, "search", false)
			m.Steps = steps
			if match != nil {
				v, e := matchValue(p, subject.Text, match)
				if e != nil {
					bad(*e)
					break
				}
				matches = value.NewList([]value.Value{v})
			}
		} else {
			v, steps, e := allMatches(p, subject.Text)
			m.Steps = steps
			if e != nil {
				bad(*e)
				break
			}
			matches = v
		}
		push(value.Value{Kind: value.Replacement, Replacement: &value.ReplacementData{Subject: subject, Matches: matches.Items}})
	case "replace-next":
		v := pop()
		replacement := *v.Replacement
		if replacement.Position >= len(replacement.Matches) {
			push(v)
			jump()
			break
		}
		match := replacement.Matches[replacement.Position]
		replacement.Position++
		push(value.Value{Kind: value.Replacement, Replacement: &replacement})
		push(match)
	case "replace-put":
		part := pop()
		v := pop()
		replacement := *v.Replacement
		match := replacement.Matches[replacement.Position-1]
		span := match.Get("range")
		first, _ := span.Items[0].Number.Int64()
		last, _ := span.Items[1].Number.Int64()
		bounds, _ := coreunicode.Boundaries(replacement.Subject.Text)
		replacement.Parts = append(slices.Clone(replacement.Parts), replacement.Subject.Text[replacement.At:bounds[first-1]], textForm(part))
		replacement.At = bounds[last]
		push(value.Value{Kind: value.Replacement, Replacement: &replacement})
	case "replace-end":
		v := pop()
		replacement := v.Replacement
		push(text(strings.Join(replacement.Parts, "") + replacement.Subject.Text[replacement.At:]))
	case "contains", "begins-with", "ends-with", "matches", "match-all":
		needle, subject := pop(), pop()
		if i.Name == "match-all" {
			needle, subject = subject, needle
		}
		if subject.Kind == value.Bytes && i.Name != "match-all" && i.Name != "matches" {
			if needle.Kind != value.Bytes {
				bad(wrong("bytes", needle))
				break
			}
			p := patternProgram{}
			for _, b := range needle.Bytes {
				p.Code = append(p.Code, patternInstruction{Op: "char", Text: string([]byte{b})})
			}
			p.Code = append(p.Code, patternInstruction{Op: "match"})
			chars := make([]string, len(subject.Bytes))
			for j, b := range subject.Bytes {
				chars[j] = string([]byte{b})
			}
			mode := map[string]string{"contains": "search", "begins-with": "prefix", "ends-with": "suffix"}[i.Name]
			match, steps := searchCharacters(p, chars, 0, mode, true)
			m.Steps = steps
			push(boolean(match != nil))
			break
		}
		if subject.Kind != value.Text {
			bad(wrong("text", subject))
			break
		}
		p, e := compilePattern(needle, len(args) > 0)
		if e != nil {
			bad(wrong("pattern", needle))
			break
		}
		if i.Name == "match-all" {
			v, steps, e := allMatches(p, subject.Text)
			m.Steps = steps
			if e != nil {
				bad(*e)
			} else {
				push(v)
			}
		} else {
			mode := map[string]string{"contains": "search", "begins-with": "prefix", "ends-with": "suffix", "matches": "whole"}[i.Name]
			match, steps := search(p, subject.Text, 0, mode, true)
			m.Steps = steps
			push(boolean(match != nil))
		}
	case "append", "prepend", "append-all", "prepend-all":
		part, whole := pop(), pop()
		m.Input = part
		m.InputPresent = true
		v, e := appendValue(whole, part, strings.HasPrefix(i.Name, "prepend"), strings.HasSuffix(i.Name, "-all"))
		if e != nil {
			bad(*e)
		} else {
			push(v)
		}
	case "iterate":
		v := pop()
		if v.Kind != value.List && v.Kind != value.Range {
			bad(wrong("list or integer range", v))
			break
		}
		it := value.IteratorData{Snapshot: v}
		if v.Kind == value.Range {
			for _, end := range v.Items {
				if _, ok := end.Number.Integer(); end.Kind != value.Number || !ok {
					bad(wrong("integer range", v))
					break
				}
			}
			if err != nil {
				break
			}
			it.Current = v.Items[0].Number
			it.Done = it.Current.Compare(v.Items[1].Number) > 0
		}
		push(value.Value{Kind: value.Iterator, Iterator: &it})
	case "iterate-times":
		v := pop()
		if v.Kind != value.Number {
			bad(wrong("integer", v))
			break
		}
		n, ok := v.Number.Integer()
		if !ok {
			bad(wrong("integer", v))
			break
		}
		if n.Sign() < 0 {
			bad(failure("out of range", value.Pair{Key: "field", Val: text("count")}, value.Pair{Key: "value", Val: v}))
			break
		}
		push(value.Value{Kind: value.Iterator, Iterator: &value.IteratorData{Remaining: v.Number}})
	case "next":
		v := pop()
		it, item, has := advanceIterator(*v.Iterator)
		if !has {
			push(v)
			jump()
		} else {
			push(value.Value{Kind: value.Iterator, Iterator: &it})
			push(item)
		}
	case "test-map":
		if pop().Kind != value.Map {
			jump()
		}
	case "test-list", "test-list-at-least":
		v := pop()
		if v.Kind != value.List || i.Name == "test-list" && len(v.Items) != idx(0) || len(v.Items) < idx(0) {
			jump()
		}
	case "list-item":
		v := pop()
		push(v.Items[idx(0)-1])
	case "list-rest":
		v := pop()
		push(value.NewList(v.Items[idx(0)-1:]))
	case "map-get":
		v := pop()
		k := key(name(0))
		found := false
		for _, p := range v.Entries {
			if p.Key == k {
				push(p.Val)
				found = true
				break
			}
		}
		if !found {
			jump()
		}
	case "test-constant":
		v := pop()
		c := code.Constants[idx(0)]
		if !equal(v, c, len(args) == 3) {
			jump()
		}
	case "test-equal":
		b, a := pop(), pop()
		if !a.Equal(b) {
			jump()
		}
	case "throw":
		v := pop()
		if v.Kind == value.Text {
			v, _ = value.NewMap([]value.Pair{{Key: "code", Val: v}})
		}
		if v.Kind != value.Map || v.Get("code").Kind != value.Text {
			v = failure("bad throw")
		}
		if code.Stdlib && !hasKey(v, "message") && !hasKey(v, "at") {
			for _, entry := range generated.Errors.Error {
				if entry.Code == v.Get("code").Text {
					fields := slices.DeleteFunc(slices.Clone(v.Entries), func(p value.Pair) bool { return p.Key == "code" })
					v = failure(entry.Code, fields...)
					break
				}
			}
		}
		bad(v)
	case "catch-accept":
		effect = func() { r.acceptCatch() }
	case "catch-next":
		effect = func() { r.nextCatch() }
	case "choose-offer":
		args := slices.Clone(f.Stack[len(f.Stack)-idx(1):])
		m.Count = int64(idx(1))
		effect = func() { r.Frames[len(r.Frames)-1].PC--; r.chooseOffer(name(0), args) }
	case "end-cleanup":
		if r.Cancelling {
			effect = func() { r.nextCancellationCleanup() }
			break
		}
		if len(r.Recoveries) > 0 && f.Transfer == r.Recoveries[len(r.Recoveries)-1] {
			c := f.Transfer
			effect = func() {
				if c.Pending.Kind == "error" {
					r.Raises = append(r.Raises, Raised{Unit: r.CodeName(), Handler: enclosingHandler(r.CurrentCode().Unit.Bodies[r.Frames[len(r.Frames)-1].Body].Checked), Code: c.Error.Get("code").Text, PC: r.PC, Instruction: r.At})
				}
				r.advanceTransfer(c)
			}
			break
		}
		c := r.Cleanup[len(r.Cleanup)-1]
		effect = func() {
			r.Cleanup = r.Cleanup[:len(r.Cleanup)-1]
			r.Frames[len(r.Frames)-1].PC--
			if r.Cancelling {
				r.unwind(c.Error)
			} else {
				r.raise(c.Error)
			}
		}
	case "raise":
		bad(failure(name(0)))
	case "clause-fail":
		effect = func() { r.failClause() }
	default:
		bad(failure("host error", value.Pair{Key: "operation", Val: text("unsupported instruction " + i.Name)}))
	}
	return m, effect, err
}
func nameOrEmpty(args []lower.Operand) string {
	if len(args) > 0 {
		return args[0].Text
	}
	return ""
}
func textForm(v value.Value) string {
	if v.Kind == value.Text {
		return v.Text
	}
	return v.Display()
}
func fold(v value.Value) value.Value {
	if v.Kind == value.Text {
		s, _ := coreunicode.Fold(v.Text)
		return text(s)
	} else if v.Kind == value.List || v.Kind == value.Range {
		v.Items = slices.Clone(v.Items)
		for j, x := range v.Items {
			v.Items[j] = fold(x)
		}
	} else if v.Kind == value.Map {
		v.Entries = slices.Clone(v.Entries)
		for j, p := range v.Entries {
			v.Entries[j].Val = fold(p.Val)
		}
	}
	return v
}
func compared(a, b value.Value, folded bool) int64 {
	if folded && a.Kind == value.Text && b.Kind == value.Text {
		a, b = fold(a), fold(b)
	}
	if a.Kind != b.Kind {
		return 0
	}
	switch a.Kind {
	case value.Text:
		as, _ := coreunicode.Boundaries(a.Text)
		bs, _ := coreunicode.Boundaries(b.Text)
		for j := 0; j < min(len(as), len(bs))-1; j++ {
			if a.Text[as[j]:as[j+1]] != b.Text[bs[j]:bs[j+1]] {
				return int64(j + 1)
			}
		}
		return int64(min(len(as), len(bs)) - 1)
	case value.Bytes:
		for j := 0; j < min(len(a.Bytes), len(b.Bytes)); j++ {
			if a.Bytes[j] != b.Bytes[j] {
				return int64(j + 1)
			}
		}
		return int64(min(len(a.Bytes), len(b.Bytes)))
	case value.List:
		for j := 0; j < min(len(a.Items), len(b.Items)); j++ {
			if !equal(a.Items[j], b.Items[j], folded) {
				return int64(j + 1)
			}
		}
		return int64(min(len(a.Items), len(b.Items)))
	case value.Map:
		_, scanned := compareMap(a, b, folded)
		return scanned
	}
	return 0
}

// waitNanos accepts exact durations and rounds to whole nanoseconds, half even.
func waitNanos(v value.Value) (*big.Int, *value.Value) {
	fail := func(e value.Value) (*big.Int, *value.Value) { return nil, &e }
	if v.Kind != value.Quantity {
		return fail(wrong("quantity", v))
	}
	seconds, _ := value.ParseUnit("s")
	if !v.Unit.Compatible(seconds) {
		return fail(failure("wrong kind", value.Pair{Key: "expected", Val: text("s")}, value.Pair{Key: "got", Val: text(v.Unit.String())}, value.Pair{Key: "value", Val: v}))
	}
	n, err := v.Unit.Convert(v.Number, true)
	if err != nil {
		return fail(failure(err.(*decimal.Error).Code))
	}
	return roundInteger(new(big.Rat).Mul(n.Rat(), big.NewRat(1e9, 1))), nil
}
