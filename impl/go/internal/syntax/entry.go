package syntax

import "slices"

// ParseEntry uses the same predictive parser as Script source, accepting
// exactly one declaration, statement or expression (chapter 2, Entries).
// A name starts a Command Call only for say or a known session Handler.
func ParseEntry(source string, isHandler func(string) bool) (kind string, entry *Node, err error) {
	l, err := NewLexer(source)
	if err != nil {
		return "", nil, err
	}
	p := &parser{lexer: l, base: []int{0}}
	complete := false
	defer func() {
		if v := recover(); v != nil {
			if e, ok := v.(*Error); ok {
				e.TrailingEntry = complete
				kind, entry, err = "", nil, e
			} else {
				panic(v)
			}
		}
	}()
	for p.atOperand("\n") && p.peek(Operand).Kind != EOF {
		p.take(Operand)
	}
	t := p.peek(Operand)
	if t.Kind == EOF {
		return "", nil, nil
	}
	if slices.Contains([]string{"on", "function", "private", "use", "constant"}, t.Raw) || t.Raw == "script" && p.second(Operand).Raw == "variable" {
		kind, entry = "declaration", p.declaration()
	} else if slices.Contains([]string{"if", "repeat", "match", "try", "wait", "add", "ask", "delete", "divide", "exit", "let", "multiply", "pass", "put", "replace", "return", "send", "set", "subtract", "tell", "throw", "veto"}, t.Raw) || t.Raw == "next" && p.second(Operand).Raw == "repeat" || isName(t) && (t.Raw == "say" || isHandler != nil && isHandler(t.Raw)) {
		kind, entry = "statement", p.statement(false)
		complete = true
		p.nl()
	} else {
		kind, entry = "expression", p.expression()
		complete = true
		p.nl()
	}
	complete = true
	for p.atOperand("\n") && p.peek(Operand).Kind != EOF {
		p.take(Operand)
	}
	if p.peek(Operand).Kind != EOF {
		p.fail(p.peek(Operand))
	}
	p.take(Operand)
	return
}
