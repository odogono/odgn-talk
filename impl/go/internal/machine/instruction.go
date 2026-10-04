package machine

import (
	"math/big"
	"slices"
	"strings"

	"github.com/odogono/odgn-talk/impl/go/internal/decimal"
	"github.com/odogono/odgn-talk/impl/go/internal/generated"
	"github.com/odogono/odgn-talk/impl/go/internal/lower"
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
		push(r.State.Constants[idx(0)])
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
		push(r.State.Definitions[slices.Index(r.State.Unit.Definitions, name(0))])
	case "store-definition":
		v := pop()
		slot := slices.Index(r.State.Unit.Definitions, name(0))
		effect = func() { r.State.Definitions[slot] = v }
	case "load-object":
		if v, ok := r.State.Objects[name(0)]; ok {
			push(v)
		} else if slices.Contains(r.State.ScriptNames, name(0)) {
			receiver(name(0))
		} else {
			bad(failure("object gone", value.Pair{Key: "object", Val: text(name(0))}))
		}
	case "me":
		next := r.State.Unit.Bodies[f.Body].Code[f.PC+1].Name
		if r.State.Me.Kind == value.Nothing && (next == "send" || next == "send-wait" || next == "join-send") {
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
	case "send", "send-wait", "join-send":
		if f.ReceiverNames[len(f.Stack)-1] == "" {
			bad(wrong("object", pop()))
			break
		}
		pop()
		m.Args = take(idx(1))
		m.InputSize = 32
		for _, v := range m.Args {
			m.InputSize = saturatingAdd(m.InputSize, Size(v))
		}
		if i.Name == "send-wait" {
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
		effect = func() { r.Frames = nil; r.Passed = true; r.Status = Completed }
	case "return", "veto":
		v := pop()
		effect = func() {
			r.Frames = r.Frames[:len(r.Frames)-1]
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
	case "call":
		body, n := idx(0), idx(1)
		m.Count = int64(n)
		vs := take(n)
		f.Waiting = true
		b := r.State.Unit.Bodies[body]
		for j := n; j < len(b.Checked.Node.Params); j++ {
			param := b.Checked.Node.Params[j]
			slot := slices.Index(r.State.Unit.Definitions, b.Checked.Name+"."+param.Text)
			vs = append(vs, r.State.Definitions[slot])
		}
		effect = func() { r.pushFrame(body, vs) }
	case "call-handler", "call-handler-wait":
		n := idx(1)
		vs := take(n)
		m.Count = int64(n)
		bodies := []int{}
		for _, b := range r.State.Unit.Bodies {
			if b.Checked.Kind == "handler" && b.Checked.Name == name(0) && len(b.Checked.Node.Params) == n {
				bodies = append(bodies, b.Index)
			}
		}
		if len(bodies) == 0 {
			bad(failure("no match"))
			break
		}
		f.Waiting = true
		effect = func() {
			r.pushFrame(bodies[0], vs)
			r.Frames[len(r.Frames)-1].Dispatch = &handlerDispatch{Bodies: bodies[1:], Args: vs}
		}
	case "make-function", "make-closure":
		body := r.State.Unit.Bodies[idx(0)]
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
		push(value.Value{Kind: value.Function, Function: &value.FunctionData{Home: r.State.Unit.Name, Code: body.Checked.Name, Captures: captures, Body: body.Index, Owner: r.State, Group: r.State.Group, Name: functionName}})
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
			bad(failure("would suspend"))
			break
		}
		body := r.State.Unit.Bodies[data.Body]
		maySuspend := body.Checked.MaySuspend
		for _, ins := range body.Code {
			for _, op := range generated.Machine.Instruction {
				if ins.Name == op.Name && op.Suspends {
					maySuspend = true
				}
			}
		}
		if maySuspend && i.Name == "call-value" {
			bad(failure("would suspend"))
			break
		}
		required := 0
		for _, param := range body.Checked.Node.Params {
			if body.Checked.Kind != "function" || len(param.Children) == 0 {
				required++
			}
		}
		if n < required || n > len(body.Checked.Node.Params) {
			bad(failure("wrong arity"))
			break
		}
		for j := n; j < len(body.Checked.Node.Params); j++ {
			slot := slices.Index(r.State.Unit.Definitions, body.Checked.Name+"."+body.Checked.Node.Params[j].Text)
			vs = append(vs, r.State.Definitions[slot])
		}
		f.Waiting = true
		effect = func() {
			r.pushFrame(data.Body, vs)
			callee := &r.Frames[len(r.Frames)-1]
			for _, capture := range data.Captures {
				callee.Locals[body.Checked.Slot(capture.Key)] = capture.Val
			}
		}
	case "wait":
		ns, err := waitNanos(pop())
		if err != nil {
			bad(*err)
			break
		}
		effect = func() { r.WaitNS = ns; r.Status = Suspended }
	case "wait-for", "wait-for-any":
		entry := r.State.Unit.Events[idx(0)]
		w, err := r.eventWait(i.Name, entry, take(eventValueCount(entry)))
		if err != nil {
			bad(*err)
			break
		}
		effect = func() { r.EventWait = w; r.Status = Suspended }
	case "call-builtin":
		m.Args = take(idx(1))
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
		vs := slices.Clone(list.Items)
		if i.Name == "list-extend" {
			if v.Kind != value.List {
				bad(wrong("list", v))
				break
			}
			vs = append(vs, v.Items...)
		} else {
			vs = append(vs, v)
		}
		push(value.NewList(vs))
	case "map":
		n := idx(1)
		m.Count = int64(n)
		vs := take(n)
		keys := r.State.Constants[idx(0)]
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
		if v.Kind != value.Map {
			bad(wrong("map", v))
		} else {
			push(v.Get(k))
		}
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
		err = binaryInstruction(f, i, r.State, &m)
	case "make-pattern":
		n := idx(1)
		vs := take(n)
		source := r.State.Constants[idx(0)].Text
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
		c := r.State.Constants[idx(0)]
		if !equal(v, c, len(args) == 3) {
			jump()
		}
	case "test-equal":
		b, a := pop(), pop()
		if !a.Equal(b) {
			jump()
		}
	case "throw", "rethrow":
		v := pop()
		if v.Kind == value.Text {
			v, _ = value.NewMap([]value.Pair{{Key: "code", Val: v}})
		}
		if v.Kind != value.Map || v.Get("code").Kind != value.Text {
			v = failure("bad throw")
		}
		bad(v)
	case "end-cleanup":
		c := r.Cleanup[len(r.Cleanup)-1]
		effect = func() { r.Cleanup = r.Cleanup[:len(r.Cleanup)-1]; r.Frames[len(r.Frames)-1].PC--; r.unwind(c.Error) }
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
