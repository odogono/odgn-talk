package syntax

import (
	"github.com/odogono/odgn-talk/impl/go/internal/generated"
	"slices"
	"sort"
	"strings"
)

type parser struct {
	lexer        *Lexer
	pending      []Token
	tokens       []Token
	depth        int
	base         []int
	patternDepth int
	buildDepth   int
	pinSizeDepth int
	continuation bool
}

// Parse is predictive, uses at most two pending tokens, and stops at the first
// syntax error. Lexing is lazy so a later lexical error cannot hide an earlier
// error in the parse (chapter 2).
func Parse(source string) (tree *Tree, err error) {
	l, err := NewLexer(source)
	if err != nil {
		return nil, err
	}
	p := &parser{lexer: l, base: []int{0}}
	defer func() {
		if value := recover(); value != nil {
			if e, ok := value.(*Error); ok {
				tree = nil
				err = e
			} else {
				panic(value)
			}
		}
	}()
	tree = &Tree{}
	for p.peek(Operand).Kind != EOF {
		if p.at("\n") {
			p.take(Operand)
			continue
		}
		tree.Declarations = append(tree.Declarations, p.declaration())
	}
	p.take(Operand)
	tree.Tokens = p.tokens
	return tree, nil
}

func (p *parser) peek(mode Mode) Token   { return p.look(0, mode) }
func (p *parser) second(mode Mode) Token { return p.look(1, mode) }
func (p *parser) look(index int, mode Mode) Token {
	for len(p.pending) <= index {
		lexicalMode := mode
		if p.patternDepth > 0 && mode != AfterNumber && mode != AfterAs {
			lexicalMode = Pattern
		}
		token, err := p.lexer.Next(lexicalMode)
		if err != nil {
			if e, ok := err.(*Error); ok {
				for _, hole := range e.Earlier {
					lex := &Lexer{source: p.lexer.source, pos: Position{1, 1}}
					lex.advance(hole.Start)
					inner := &parser{lexer: lex, depth: 1, base: []int{0}}
					if inner.peek(Operand).Start == hole.End {
						panic(&Error{Code: "empty interpolation", Pos: lex.positionAt(hole.At)})
					}
					inner.expression()
					if inner.peek(Operator).Start != hole.End {
						inner.fail(inner.peek(Operator))
					}
				}
			}
			panic(err)
		}
		p.tokens = append(p.tokens, token)
		pendingContinuation := len(p.pending) > 0 && slices.Contains([]string{"and", "or", "+", "-", "*", "/", "^", "&", "=", ",", "..", "is", "contains", "matches", "mod", "div", "with", "be"}, p.pending[len(p.pending)-1].Raw)
		if token.Kind == LineBreak && (p.depth > p.base[len(p.base)-1] || p.continuation || pendingContinuation) {
			continue
		}
		p.pending = append(p.pending, token)
	}
	return p.pending[index]
}
func spelling(t Token) string {
	if t.Kind == LineBreak || t.Kind == EOF {
		return "\n"
	}
	return t.Raw
}
func (p *parser) at(s string) bool { return spelling(p.peek(Operator)) == s }

// atOperand checks an optional production where an expression or binding may
// follow. Chapter 1 fixes the mode before lexing, including for lookahead.
func (p *parser) atOperand(s string) bool { return spelling(p.peek(Operand)) == s }
func (p *parser) pair(a, b string) bool   { return p.at(a) && spelling(p.second(Operator)) == b }
func (p *parser) acceptOperand(s string) bool {
	if p.atOperand(s) {
		p.take(Operand)
		return true
	}
	return false
}
func (p *parser) take(mode Mode) Token {
	token := p.peek(mode)
	p.pending = p.pending[1:]
	switch token.Raw {
	case "(", "[", "{", "<<":
		p.depth++
	case ")", "]", "}", ">>":
		p.depth--
	}
	// The last words of `does not contain`, `does not match`, `is greater than`,
	// `is less than`, `is at least` and `is at most` continue too (ADR 0075).
	p.continuation = token.Raw == "," || mode == Operator && slices.Contains([]string{"+", "-", "*", "/", "^", "&", "=", "<>", "<", ">", "<=", ">=", "..", "and", "or", "is", "mod", "div", "contains", "matches", "with", "be", "contain", "match", "than", "least", "most"}, token.Raw)
	return token
}
func (p *parser) fail(t Token) {
	panic(&Error{Code: "unexpected token", Pos: t.Pos, Incomplete: t.Kind == EOF})
}
func (p *parser) expect(s string) Token {
	t := p.peek(Operator)
	if spelling(t) != s {
		p.fail(t)
	}
	return p.take(Operator)
}
func (p *parser) accept(s string) bool {
	if p.at(s) {
		p.take(Operator)
		return true
	}
	return false
}
func isName(t Token) bool {
	return t.Kind == Word && t.Raw != "_" && !slices.Contains(generated.Grammar.Reserved, t.Raw)
}

// Argument Labels are data-driven and read after a complete argument or pattern.
func isLabel(t Token) bool {
	return t.Kind == Word && (isName(t) || slices.Contains(generated.Grammar.Labels.Reserved, t.Raw)) && !slices.Contains(generated.Grammar.Labels.Excluded, t.Raw)
}
func selector(name string, labels []string) string {
	if len(labels) == 0 {
		return name
	}
	return name + ":" + strings.Join(labels, ":") + ":"
}
func (p *parser) labelled(item func() *Node, items *[]*Node) []string {
	var labels []string
	for isLabel(p.peek(Operator)) {
		labels = append(labels, p.take(Operand).Raw)
		*items = append(*items, item())
	}
	return labels
}
func (p *parser) commandPhrase(n *Node) {
	if !startsOperand(p.peek(Operand)) {
		return
	}
	n.Children = []*Node{p.expression()}
	if p.at(",") {
		for p.accept(",") {
			n.Children = append(n.Children, p.expression())
		}
	} else {
		n.Text = selector(n.Text, p.labelled(p.expression, &n.Children))
	}
}
func (p *parser) name() Token {
	t := p.peek(Operand)
	if !isName(t) {
		p.fail(t)
	}
	return p.take(Operand)
}
func (p *parser) word() Token {
	t := p.peek(Operand)
	if t.Kind != Word {
		p.fail(t)
	}
	return p.take(Operand)
}
func node(kind string, t Token, children ...*Node) *Node {
	return &Node{Kind: kind, Token: t, Text: t.Raw, Children: children}
}
func (p *parser) nl() { p.expect("\n") }
func (p *parser) closing(name string) Token {
	t := p.expect("end")
	if p.at(name) {
		p.take(Operand)
	} else if isName(p.peek(Operand)) {
		p.fail(p.peek(Operand))
	}
	return t
}
func (p *parser) declaration() *Node {
	first := p.peek(Operand)
	private := p.accept("private")
	t := p.peek(Operand)
	n := node(t.Raw, p.take(Operand))
	n.Private = private
	if private {
		n.Token = first
	}
	switch t.Raw {
	case "script":
		if private {
			p.fail(t)
		}
		p.expect("variable")
		n.Kind = "variable"
		name := p.name()
		n.Text = name.Raw
		n.NameToken = name
		n.Params = []*Node{node("name", name)}
		if p.accept("=") {
			n.Children = []*Node{p.expression()}
		}
		p.nl()
	case "constant":
		name := p.name()
		n.Text = name.Raw
		n.NameToken = name
		n.Params = []*Node{node("name", name)}
		p.expect("=")
		n.Children = []*Node{p.expression()}
		p.nl()
	case "use":
		if private {
			p.fail(t)
		}
		n.Params = append(n.Params, node("name", p.name()))
		for p.accept(",") {
			n.Params = append(n.Params, node("name", p.name()))
		}
		p.expect("from")
		n.NameToken = p.name()
		n.Text = n.NameToken.Raw
		if len(n.Params) == 1 && p.accept("as") {
			n.Children = append(n.Children, node("name", p.name()))
		}
		p.nl()
	case "on", "function":
		n.Kind = "handler"
		if t.Raw == "function" {
			n.Kind = "function"
		}
		// `on any message m`: the Fallback Handler, whose head is exactly one
		// pattern. `any` before `message` is decided on two tokens, so `on any
		// x` still declares a Handler named `any` (ADR 0064).
		fallback := n.Kind == "handler" && p.atAnyMessage()
		var name Token
		if fallback {
			name = p.take(Operand)
			p.take(Operand)
			n.Text = FallbackName
			n.NameToken = name
			n.Params = []*Node{p.bindingPattern()}
		} else {
			name = p.name()
			if n.Kind == "handler" && name.Raw == "all" {
				p.fail(name)
			}
			n.Text = name.Raw
			n.NameToken = name
		}
		for !fallback && !p.atOperand("\n") && !p.at("where") && !p.at(",") && (n.Kind != "handler" || !p.suffixStart()) {
			if n.Kind == "function" {
				param := node("name", p.name())
				if p.accept("=") {
					param.Children = []*Node{p.expression()}
				}
				n.Params = append(n.Params, param)
			} else {
				n.Params = append(n.Params, p.bindingPattern())
				if len(n.Params) == 1 {
					n.Text = selector(n.Text, p.labelled(p.bindingPattern, &n.Params))
				}
			}
			if !p.at(",") {
				break
			}
			if n.Kind == "handler" && p.suffixStart() {
				break
			}
			if n.Kind == "handler" && strings.Contains(n.Text, ":") {
				p.fail(p.second(Operand))
			}
			p.take(Operator)
		}
		if n.Kind == "handler" && p.accept("where") {
			n.Guard = p.expression()
		}
		for n.Kind == "handler" && p.accept(",") {
			suffix := p.word()
			if !slices.Contains([]string{"queued", "dropping", "replacing", "deciding", "during"}, suffix.Raw) {
				p.fail(suffix)
			}
			n.Flags = append(n.Flags, suffix)
			if suffix.Raw == "during" {
				n.Flags = append(n.Flags, p.name())
			}
		}
		p.nl()
		n.Body = p.block("end", "finally")
		if n.Kind == "handler" && p.at("finally") {
			f := node("finally", p.take(Operand))
			p.nl()
			f.Body = p.block("end")
			n.Branches = append(n.Branches, f)
		}
		if fallback {
			// A Fallback ends with `end any message` or a bare `end`.
			n.End = p.expect("end")
			if p.atAnyMessage() {
				p.take(Operand)
				p.take(Operand)
			} else if !p.atOperand("\n") {
				p.fail(p.peek(Operand))
			}
		} else {
			n.End = p.closing(name.Raw)
		}
		p.nl()
	default:
		p.fail(t)
	}
	return n
}

// FallbackName names the Fallback Handler's bodies and its `pass`. It holds a
// space, so it is never a Selector (ADR 0064).
const FallbackName = "any message"

// IsFallback reports whether a declaration is a Fallback Handler clause.
func (n *Node) IsFallback() bool { return n.Kind == "handler" && n.Text == FallbackName }

// atAnyMessage decides `any message` after `on`, `pass` or a Handler's `end`
// on two tokens; otherwise `any` is a Name (chapter 2, any-message).
func (p *parser) atAnyMessage() bool {
	t := p.peek(Operand)
	if t.Kind != Word || t.Raw != "any" {
		return false
	}
	next := p.second(Operand)
	return next.Kind == Word && next.Raw == "message"
}
func (p *parser) suffixStart() bool {
	return p.at(",") && slices.Contains([]string{"queued", "dropping", "replacing", "deciding", "during"}, p.second(Operand).Raw)
}
func (p *parser) block(ends ...string) []*Node {
	var body []*Node
	for {
		t := p.peek(Operand)
		if t.Kind == EOF || slices.Contains(ends, t.Raw) {
			return body
		}
		if t.Kind == LineBreak {
			p.take(Operand)
			continue
		}
		body = append(body, p.statement(false))
		p.nl()
	}
}
func (p *parser) expressionList() []*Node {
	args := []*Node{p.expression()}
	for p.accept(",") {
		args = append(args, p.expression())
	}
	return args
}

// sendList reads a receiver-last `send`'s `with` list, whose items may
// spread a list as a list literal's do (ADR 0064).
func (p *parser) sendList() []*Node {
	item := func() *Node {
		if p.acceptOperand("...") {
			e := p.expression()
			return node("spread", e.Token, e)
		}
		return p.expression()
	}
	args := []*Node{item()}
	for p.accept(",") {
		args = append(args, item())
	}
	return args
}
func (p *parser) andWait(n *Node) {
	if p.pair("and", "wait") {
		n.Flags = append(n.Flags, p.take(Operator))
		p.expect("wait")
	}
}

// operation reads an Operation name, which may be any word, then its
// arguments, and `and wait` where waits allows it.
func (p *parser) operation(n *Node, waits bool) {
	n.NameToken = p.word()
	n.Text = n.NameToken.Raw
	if !p.atOperand("\n") && !p.at("else") && !p.pair("and", "wait") {
		n.Children = p.expressionList()
	}
	if waits {
		p.andWait(n)
	}
}

// operationLines reads a `tell` block's lines up to its `end` (ADR 0063).
// Each line is an `ask` of the block's receiver, marked as a line, and the
// checker makes it a `tell` when its Operation is fire-and-forget.
func (p *parser) operationLines(receiver *Node) []*Node {
	var lines []*Node
	for {
		t := p.peek(Operand)
		if t.Kind == EOF || t.Raw == "end" {
			return lines
		}
		if t.Kind == LineBreak {
			p.take(Operand)
			continue
		}
		line := node("ask", t)
		line.Params = []*Node{receiver}
		line.Flags = append(line.Flags, Token{Raw: "line"})
		p.operation(line, true)
		lines = append(lines, line)
		p.nl()
	}
}
func (p *parser) statement(inline bool) *Node {
	t := p.peek(Operand)
	if slices.Contains([]string{"if", "repeat", "match", "try"}, t.Raw) && inline {
		p.fail(t)
	}
	if t.Raw == "if" {
		return p.ifStatement()
	}
	if t.Raw == "repeat" {
		return p.repeatStatement()
	}
	if t.Raw == "match" {
		return p.matchStatement()
	}
	if t.Raw == "try" {
		return p.tryStatement()
	}
	if t.Raw == "wait" {
		return p.waitStatement(inline)
	}
	// At the start of a statement where a block may go, `with` then `timeout`
	// opens a Timeout Block (ADR 0073); otherwise `with` is a Command Call.
	if t.Raw == "with" && !inline && p.second(Operand).Raw == "timeout" {
		n := node("timeout-block", p.take(Operand))
		p.take(Operand)
		p.expect("of")
		n.Children = []*Node{p.expression()}
		p.nl()
		n.Body = p.block("end")
		n.End = p.closing("timeout")
		return n
	}
	if t.Raw == "choose" && p.second(Operand).Raw == "offer" {
		n := node("choose-offer", p.take(Operand))
		p.expect("offer")
		n.NameToken = p.name()
		n.Text = n.NameToken.Raw
		if open := p.peek(Operator); open.Raw == "(" && open.Leading == "" {
			p.take(Operator)
			if !p.atOperand(")") {
				n.Children = p.expressionList()
			}
			p.expect(")")
		}
		return n
	}
	n := node(t.Raw, p.take(Operand))
	switch t.Raw {
	case "put":
		if p.atOperand("...") {
			p.take(Operand)
			n.Flags = append(n.Flags, Token{Raw: "..."})
		}
		n.Children = append(n.Children, p.expression())
		op := p.peek(Operator)
		if !slices.Contains([]string{"into", "after", "before"}, op.Raw) || len(n.Flags) > 0 && op.Raw == "into" {
			p.fail(op)
		}
		n.Text = p.take(Operand).Raw
		n.Children = append(n.Children, p.container())
	case "let":
		n.Children = append(n.Children, p.bindingPattern())
		p.expect("be")
		n.Children = append(n.Children, p.expression())
	case "set":
		n.Children = append(n.Children, p.container())
		p.expect("to")
		n.Children = append(n.Children, p.expression())
	case "add", "subtract":
		n.Children = append(n.Children, p.expression())
		sep := "to"
		if t.Raw == "subtract" {
			sep = "from"
		}
		p.expect(sep)
		n.Children = append(n.Children, p.container())
	case "multiply", "divide":
		n.Children = append(n.Children, p.container())
		p.expect("by")
		n.Children = append(n.Children, p.expression())
	case "delete":
		n.Children = append(n.Children, p.container())
	case "replace":
		if p.atOperand("first") && p.second(Operand).Raw != "in" {
			p.take(Operand)
			n.Flags = append(n.Flags, Token{Raw: "first"})
		}
		n.Children = append(n.Children, p.chunkLevel())
		p.expect("in")
		n.Children = append(n.Children, p.container())
		p.expect("with")
		n.Children = append(n.Children, p.expression())
	case "send":
		if p.atOperand("to") {
			p.take(Operand)
			n.Params = []*Node{p.expression()}
			p.expect(":")
			n.NameToken = p.name()
			if n.NameToken.Raw == "all" {
				p.fail(n.NameToken)
			}
			n.Text = n.NameToken.Raw
			p.commandPhrase(n)
			p.andWait(n)
			break
		}
		// `send (<name>) with …`: a computed message name, kept after the
		// receiver in Params. `(` can't start a Name, so one token decides
		// (ADR 0057).
		var computed *Node
		if p.atOperand("(") {
			computed = p.primary()
		} else {
			name := p.name()
			if name.Raw == "all" {
				p.fail(name)
			}
			n.Text = name.Raw
			n.NameToken = name
		}
		if p.accept("with") {
			n.Children = p.sendList()
		}
		p.expect("to")
		n.Params = []*Node{p.expression()}
		if computed != nil {
			n.Params = append(n.Params, computed)
		}
		p.andWait(n)
	case "ask", "tell":
		n.Params = []*Node{p.expression()}
		// After `tell`'s receiver, the end of the line opens a block (ADR 0063).
		if t.Raw == "tell" && !inline && (p.at("\n") || p.peek(Operator).Kind == EOF) {
			n.Kind = "tell-block"
			p.nl()
			n.Body = p.operationLines(n.Params[0])
			n.End = p.closing("tell")
			break
		}
		p.expect("to")
		p.operation(n, t.Raw == "ask")
	case "return", "veto":
		if !p.atOperand("\n") && !p.at("else") {
			n.Children = []*Node{p.expression()}
		}
	case "throw":
		n.Children = []*Node{p.expression()}
	case "pass":
		if p.atAnyMessage() {
			// `pass any message`: the Fallback Handler's pass (ADR 0064).
			n.NameToken = p.take(Operand)
			p.take(Operand)
			n.Text = FallbackName
			break
		}
		name := p.name()
		n.NameToken = name
		if name.Raw == "all" {
			p.fail(name)
		}
		var labels []string
		for isLabel(p.peek(Operator)) {
			labels = append(labels, p.take(Operand).Raw)
		}
		n.Text = selector(name.Raw, labels)
	case "exit":
		p.expect("repeat")
	default:
		if t.Raw == "next" && p.acceptOperand("repeat") {
			n.Kind = "next"
			break
		}
		if !isName(t) {
			p.fail(t)
		}
		if p.atOperand("(") && p.peek(Operator).Start == t.End {
			n.Kind = "call-statement"
			n.Children = []*Node{p.call(t)}
		} else {
			n.Kind = "command"
			p.commandPhrase(n)
		}
		p.andWait(n)
	}
	return n
}
func (p *parser) container() *Node {
	t := p.peek(Operand)
	n := p.chunkLevel()
	root := n
	for {
		if root.Kind == "chunk" {
			root = root.Children[1]
		} else if root.Kind == "key" || root.Kind == "key-computed" {
			root = root.Children[len(root.Children)-1]
		} else if root.Kind == "delimited" || root.Kind == "paren" {
			root = root.Children[0]
		} else {
			break
		}
	}
	if root.Kind != "name" && !(root.Kind == "literal" && root.Text == "it") && !(root.Kind == "literal" && root.Text == "me" && n.Kind == "key") {
		panic(&Error{Code: "not a container", Pos: t.Pos})
	}
	return n
}
func (p *parser) branchBody() []*Node {
	if p.accept("\n") {
		return p.block("when", "else", "end", "after")
	}
	body := []*Node{p.statement(true)}
	p.nl()
	return body
}
func (p *parser) ifStatement() *Node {
	n := node("if", p.take(Operand))
	arm := node("arm", n.Token)
	arm.Children = []*Node{p.expression()}
	p.expect("then")
	if !p.at("\n") {
		arm.Body = []*Node{p.statement(true)}
		n.Branches = append(n.Branches, arm)
		if p.accept("else") {
			n.HasElse = true
			n.Body = []*Node{p.statement(true)}
		}
		return n
	}
	p.nl()
	arm.Body = p.block("else", "end")
	n.Branches = append(n.Branches, arm)
	for p.accept("else") {
		if p.accept("if") {
			arm = node("arm", n.Token)
			arm.Children = []*Node{p.expression()}
			p.expect("then")
			p.nl()
			arm.Body = p.block("else", "end")
			n.Branches = append(n.Branches, arm)
		} else {
			n.HasElse = true
			p.nl()
			n.Body = p.block("end")
			break
		}
	}
	n.End = p.closing("if")
	return n
}
func (p *parser) repeatStatement() *Node {
	n := node("repeat", p.take(Operand))
	t := p.peek(Operand)
	switch t.Raw {
	case "for":
		p.take(Operand)
		p.expect("each")
		n.Text = "each"
		n.Params = []*Node{p.bindingPattern()}
		p.expect("in")
		n.Children = []*Node{p.expression()}
	case "while", "until":
		n.Text = p.take(Operand).Raw
		n.Children = []*Node{p.expression()}
	case "forever":
		n.Text = p.take(Operand).Raw
	default:
		n.Text = "times"
		n.Children = []*Node{p.expression()}
		p.expect("times")
	}
	if p.at("collecting") {
		clause := node("collecting", p.take(Operator))
		clause.Children = []*Node{p.expression()}
		p.expect("into")
		clause.Params = []*Node{node("collecting-target", p.name())}
		n.Collect = clause
	}
	p.nl()
	n.Body = p.block("end")
	n.End = p.closing("repeat")
	return n
}
func (p *parser) matchStatement() *Node {
	n := node("match", p.take(Operand))
	n.Children = []*Node{p.expression()}
	if p.pair("ignoring", "case") {
		n.Flags = append(n.Flags, p.take(Operator))
		p.expect("case")
	}
	p.nl()
	for !p.at("end") && !p.at("else") {
		if p.accept("\n") {
			continue
		}
		b := node("when", p.expect("when"))
		if p.atOperand("contains") && p.second(Operand).Raw == "<" {
			b.Flags = append(b.Flags, p.take(Operand))
		}
		b.Params = []*Node{p.bindingPattern()}
		if p.accept("where") {
			b.Guard = p.expression()
		}
		p.expect("then")
		b.Body = p.branchBody()
		n.Branches = append(n.Branches, b)
	}
	if p.accept("else") {
		n.Body = p.branchBody()
		for p.accept("\n") {
		}
	}
	n.End = p.closing("match")
	return n
}
func (p *parser) tryStatement() *Node {
	n := node("try", p.take(Operand))
	p.nl()
	n.Body = p.block("offer", "catch", "finally", "end")
	for p.at("offer") {
		b := node("offer", p.take(Operand))
		b.NameToken = p.name()
		b.Text = b.NameToken.Raw
		if !p.atOperand("\n") && p.peek(Operand).Kind != EOF {
			b.Params = append(b.Params, node("offer-parameter", p.name()))
			for p.accept(",") {
				b.Params = append(b.Params, node("offer-parameter", p.name()))
			}
		}
		p.nl()
		b.Body = p.block("offer", "catch", "finally", "end")
		n.Branches = append(n.Branches, b)
	}
	for p.at("catch") {
		b := node("catch", p.take(Operand))
		b.Params = []*Node{p.bindingPattern()}
		if p.at("before") {
			b.Flags = append(b.Flags, p.take(Operator))
			p.expect("unwind")
		}
		if p.accept("where") {
			b.Guard = p.expression()
		}
		p.nl()
		b.Body = p.block("catch", "finally", "end")
		n.Branches = append(n.Branches, b)
	}
	if p.at("finally") {
		b := node("finally", p.take(Operand))
		p.nl()
		b.Body = p.block("end")
		n.Branches = append(n.Branches, b)
	}
	n.End = p.closing("try")
	return n
}
func (p *parser) event(t Token) *Node {
	e := node("event", t)
	name := p.name()
	if name.Raw == "all" {
		p.fail(name)
	}
	e.Text = name.Raw
	for !p.atOperand("\n") && !p.at("where") && !p.at("then") && !p.at("or") && !(p.at("from") && startsOperand(p.second(Operand))) {
		e.Params = append(e.Params, p.bindingPattern())
		if len(e.Params) == 1 {
			labels := p.labelled(p.bindingPattern, &e.Params)
			e.Text = selector(e.Text, labels)
			if len(labels) > 0 {
				break
			}
		}
		if !p.accept(",") {
			break
		}
	}
	if p.at("from") && startsOperand(p.second(Operand)) {
		p.take(Operand)
		e.Children = []*Node{p.chunkLevel()}
	}
	if p.accept("where") {
		e.Guard = p.expression()
	}
	return e
}
func (p *parser) waitStatement(inline bool) *Node {
	n := node("wait", p.take(Operand))
	if !p.atOperand("for") {
		n.Children = []*Node{p.expression()}
		return n
	}
	p.take(Operand)
	if p.at("all") {
		if inline {
			p.fail(p.peek(Operand))
		}
		p.take(Operand)
		n.Kind = "join"
		p.nl()
		n.Body = p.block("end")
		n.End = p.closing("wait")
		return n
	}
	n.Kind = "wait-for"
	if p.at("\n") {
		if inline {
			p.fail(p.peek(Operand))
		}
		p.nl()
		n.Kind = "wait-any"
		for !p.at("end") {
			if p.accept("\n") {
				continue
			}
			t := p.peek(Operand)
			var b *Node
			if p.accept("when") {
				b = p.event(t)
			} else {
				p.expect("after")
				b = node("after", t)
				b.Children = []*Node{p.expression()}
			}
			p.expect("then")
			b.Body = p.branchBody()
			n.Branches = append(n.Branches, b)
		}
		n.End = p.closing("wait")
		return n
	}
	n.Branches = []*Node{p.event(n.Token)}
	if p.accept("or") {
		n.Children = []*Node{p.expression()}
	}
	return n
}
func startsIndex(t Token) bool {
	return startsOperand(t) && !slices.Contains([]string{"<", "<<"}, t.Raw)
}
func startsOperand(t Token) bool {
	if t.Kind == Number || t.Kind == Text || t.Kind == Template || isName(t) {
		return !slices.Contains(generated.Grammar.Follow, t.Raw)
	}
	return slices.Contains([]string{"(", "[", "{", "<", "<<", "-", "not", "given", "the", "every", "replace", "true", "false", "nothing", "it", "me"}, t.Raw)
}
func (p *parser) expression() *Node {
	if p.atOperand("given") {
		return p.lambda()
	}
	return p.binary(1)
}
func (p *parser) lambda() *Node {
	n := node("lambda", p.take(Operand))
	p.base = append(p.base, p.depth)
	for !p.atOperand(":") && !p.at("\n") {
		n.Params = append(n.Params, p.bindingPattern())
		if !p.accept(",") {
			break
		}
	}
	if p.accept(":") {
		n.Children = []*Node{p.expression()}
	} else {
		p.nl()
		n.Body = p.block("end")
		n.End = p.closing("given")
	}
	p.base = p.base[:len(p.base)-1]
	return n
}
func (p *parser) binary(level int) *Node {
	if level == 3 {
		if p.atOperand("not") {
			t := p.take(Operand)
			return node("unary", t, p.binary(3))
		}
		return p.binary(4)
	}
	if level == 10 {
		if p.atOperand("-") {
			t := p.take(Operand)
			return node("unary", t, p.binary(10))
		}
		return p.conversion()
	}
	if level == 4 {
		return p.comparison()
	}
	left := p.binary(level + 1)
	var ops []string
	switch level {
	case 1:
		ops = []string{"or"}
	case 2:
		ops = []string{"and"}
	case 5:
		ops = []string{"&"}
	case 6:
		ops = []string{".."}
	case 7:
		ops = []string{"+", "-"}
	case 8:
		ops = []string{"*", "/", "mod", "div"}
	case 9:
		ops = []string{"^"}
	}
	for slices.Contains(ops, p.peek(Operator).Raw) {
		if p.pair("and", "wait") {
			break
		}
		t := p.take(Operator)
		rightLevel := level + 1
		if level == 9 {
			rightLevel = level
		}
		left = node("binary", t, left, p.binary(rightLevel))
		if level == 6 || level == 9 {
			break
		}
	}
	return left
}
func (p *parser) kind() *Node {
	t := p.peek(AfterAs)
	if t.Kind == Unit {
		return node("kind", p.take(AfterAs))
	}
	if t.Raw == "function" {
		return node("kind", p.take(Operand))
	}
	t = p.name()
	n := node("kind", t)
	if t.Raw == "civil" && p.accept("date") {
		n.Text = "civil date"
	}
	return n
}
func (p *parser) comparison() *Node {
	left := p.binary(5)
	t := p.peek(Operator)
	op := t.Raw
	if slices.Contains([]string{"=", "<>", "<", ">", "<=", ">=", "contains", "matches"}, op) {
		p.take(Operator)
		left = node("binary", t, left, p.binary(5))
	} else if p.pair("begins", "with") || p.pair("ends", "with") {
		p.take(Operator)
		p.expect("with")
		left = node("binary", t, left, p.binary(5))
		left.Text = op + " with"
	} else if op == "is" {
		p.take(Operator)
		neg := p.acceptOperand("not")
		op = "is"
		if neg {
			op = "is not"
		}
		if p.acceptOperand("in") {
			left = node("binary", t, left, p.binary(5))
			left.Text = op + " in"
		} else if (p.at("a") || p.at("an")) && (isName(p.second(Operand)) || p.second(Operand).Raw == "function") {
			p.take(Operand)
			left = node("kind-test", t, left, p.kind())
			left.Text = op + " a"
		} else if p.accept("empty") {
			left = node("empty-test", t, left)
			left.Text = op + " empty"
		} else if p.atOperand("greater") && spelling(p.second(Operator)) == "than" || p.atOperand("less") && spelling(p.second(Operator)) == "than" || p.atOperand("at") && slices.Contains([]string{"least", "most"}, spelling(p.second(Operator))) {
			// `is greater than`, `is at least` and the rest (ADR 0075).
			first := p.take(Operator).Raw
			second := p.take(Operator).Raw
			if first == "at" {
				first += " " + second
			} else {
				first += " than"
			}
			left = node("binary", t, left, p.binary(5))
			left.Text = op + " " + first
		} else {
			left = node("binary", t, left, p.binary(5))
			left.Text = op
		}
	} else if p.pair("comes", "before") || p.pair("comes", "after") {
		p.take(Operator)
		left = node("binary", t, left, nil)
		left.Text = "comes " + p.take(Operator).Raw
		left.Children[1] = p.binary(5)
	} else if p.pair("does", "not") {
		p.take(Operator)
		p.take(Operator)
		word := p.peek(Operator)
		if !slices.Contains([]string{"contain", "begin", "end", "match"}, word.Raw) {
			p.fail(word)
		}
		p.take(Operator)
		left = node("binary", t, left, nil)
		left.Text = "does not " + word.Raw
		if word.Raw == "begin" || word.Raw == "end" {
			p.expect("with")
			left.Text += " with"
		}
		left.Children[1] = p.binary(5)
	} else if p.pair("can", "be") {
		p.take(Operator)
		p.expect("be")
		if p.at("a") || p.at("an") {
			p.take(Operand)
		}
		left = node("kind-test", t, left, p.kind())
		left.Text = "can be"
	}
	if p.pair("ignoring", "case") && (left.Kind == "binary" || left.Kind == "kind-test" || left.Kind == "empty-test") {
		left.Flags = append(left.Flags, p.take(Operator))
		p.expect("case")
	}
	return left
}
func (p *parser) conversion() *Node {
	n := p.chunkLevel()
	for p.at("as") {
		t := p.peek(Operator)
		if p.buildDepth > 0 {
			second := p.second(AfterAs)
			if slices.Contains(generated.Grammar.BinaryPatterns.IntegerTypes, second.Raw) || second.Kind == Number || second.Raw == "(" || second.Raw == "^" {
				break
			}
		}
		p.take(Operator)
		n = node("convert", t, n, p.kind())
	}
	return n
}
func (p *parser) chunkLevel() *Node {
	n := p.postfix()
	if p.pair("delimited", "by") && (n.Kind == "chunk" || n.Kind == "key" && slices.Contains([]string{"items", "words", "lines", "characters", "bytes", "code points"}, n.Text)) {
		t := p.take(Operator)
		p.expect("by")
		n = node("delimited", t, n, p.postfix())
	}
	return n
}
func (p *parser) postfix() *Node {
	n := p.primary()
	for p.at("'s") {
		t := p.take(Operator)
		key := p.key()
		next := node("key", t, n)
		next.Text = key.Text
		next.Params = []*Node{key}
		n = next
	}
	return n
}
func chunkName(s string) string {
	for _, c := range generated.Grammar.Chunk {
		if s == c.Singular || s == c.Plural {
			return c.Singular
		}
	}
	return ""
}
func (p *parser) key() *Node {
	t := p.word()
	n := node("key-name", t)
	if t.Raw == "code" && p.accept("points") {
		n.Text = "code points"
	}
	return n
}
func (p *parser) primary() *Node {
	t := p.peek(Operand)
	switch {
	case t.Kind == Number:
		p.take(Operand)
		n := node("literal", t)
		if p.peek(AfterNumber).Kind == Unit {
			n.Params = []*Node{node("unit", p.take(AfterNumber))}
		}
		return n
	case t.Kind == Template:
		p.take(Operand)
		return p.interpolated(t)
	case t.Kind == Text:
		p.take(Operand)
		n := node("literal", t)
		n.Text = t.Value
		return n
	case slices.Contains([]string{"true", "false", "nothing", "it", "me"}, t.Raw):
		return node("literal", p.take(Operand))
	case t.Raw == "(":
		p.take(Operand)
		build := p.buildDepth
		p.buildDepth = 0
		n := node("paren", t, p.expression())
		p.buildDepth = build
		n.End = p.expect(")")
		return n
	case t.Raw == "[":
		return p.collection(false)
	case t.Raw == "{":
		return p.collection(true)
	case t.Raw == "<":
		return p.textPattern()
	case t.Raw == "^" && p.pinSizeDepth > 0:
		p.take(Operand)
		n := node("pin", t)
		n.NameToken = p.name()
		n.Text = n.NameToken.Raw
		return n
	case t.Raw == "<<":
		return p.binaryPattern(false)
	case t.Raw == "the":
		return p.the()
	case t.Raw == "replace":
		p.take(Operand)
		n := node("replace-expression", t)
		if p.atOperand("first") && p.second(Operand).Raw != "in" {
			p.take(Operand)
			n.Flags = append(n.Flags, Token{Raw: "first"})
		}
		n.Children = append(n.Children, p.chunkLevel())
		p.expect("in")
		n.Children = append(n.Children, p.binary(1))
		p.expect("with")
		n.Children = append(n.Children, p.binary(5))
		return n
	case p.pair("every", "match"):
		p.take(Operand)
		p.expect("match")
		p.expect("of")
		n := node("match-all", t, p.chunkLevel())
		p.expect("in")
		n.Children = append(n.Children, p.binary(5))
		return n
	case isName(t):
		p.take(Operand)
		if p.at("(") && p.peek(Operator).Start == t.End {
			return p.call(t)
		}
		kind := chunkName(t.Raw)
		if t.Raw == "code" && (p.at("point") || p.at("points")) {
			p.take(Operand)
			kind = "code point"
		}
		if kind != "" && startsIndex(p.peek(Operand)) {
			n := node("chunk", t, p.binary(6))
			n.Text = kind
			p.expect("of")
			n.Children = append(n.Children, p.postfix())
			return n
		}
		return node("name", t)
	default:
		p.fail(t)
		return nil
	}
}
func (p *parser) call(t Token) *Node {
	build := p.buildDepth
	p.buildDepth = 0
	defer func() { p.buildDepth = build }()
	p.expect("(")
	n := node("call", t)
	if !p.atOperand(")") {
		n.Children = p.expressionList()
	}
	n.End = p.expect(")")
	return n
}
func (p *parser) the() *Node {
	t := p.take(Operand)
	if p.at("target") && p.second(Operator).Raw != "of" {
		p.take(Operand)
		return node("target", t)
	}
	if p.accept("(") {
		key := p.expression()
		p.expect(")")
		p.expect("of")
		return node("key-computed", t, key, p.postfix())
	}
	k := p.peek(Operand)
	if slices.Contains(generated.Grammar.Ordinals, k.Raw) && (chunkName(p.second(Operand).Raw) != "" || p.second(Operand).Raw == "code") {
		p.take(Operand)
		c := p.word()
		kind := chunkName(c.Raw)
		if c.Raw == "code" {
			p.expect("point")
			kind = "code point"
		} else {
			for _, entry := range generated.Grammar.Chunk {
				if c.Raw == entry.Plural {
					p.fail(c)
				}
			}
		}
		index := slices.Index(generated.Grammar.Ordinals, k.Raw) + 1
		if k.Raw == "last" {
			index = -1
		}
		ordinal := node("ordinal", c)
		ordinal.Text = k.Raw
		if index == -1 {
			ordinal.Text = "last"
		} else {
			ordinal.Text = k.Raw
		}
		p.expect("of")
		n := node("chunk", c, ordinal, p.postfix())
		n.Text = kind
		return n
	}
	var key *Node
	if k.Kind == Text {
		p.take(Operand)
		key = node("key-name", k)
		key.Text = k.Value
	} else {
		key = p.key()
	}
	p.expect("of")
	n := node("key", t, p.postfix())
	n.Text = key.Text
	n.Params = []*Node{key}
	return n
}
func (p *parser) collection(mapping bool) *Node {
	build := p.buildDepth
	p.buildDepth = 0
	defer func() { p.buildDepth = build }()
	t := p.take(Operand)
	close := "]"
	kind := "list"
	if mapping {
		close = "}"
		kind = "map"
	}
	n := node(kind, t)
	if !p.atOperand(close) {
		for {
			if mapping {
				k := p.peek(Operand)
				if k.Kind != Word && k.Kind != Text || k.Kind == Word && k.Raw == "offer" {
					p.fail(k)
				}
				p.take(Operand)
				p.expect(":")
				entry := node("entry", k, p.expression())
				if k.Kind == Text {
					entry.Text = k.Value
				}
				n.Children = append(n.Children, entry)
			} else {
				spread := p.atOperand("...")
				if spread {
					p.take(Operand)
				}
				item := p.expression()
				if spread {
					item = node("spread", item.Token, item)
				}
				n.Children = append(n.Children, item)
			}
			if !p.accept(",") {
				break
			}
		}
	}
	n.End = p.expect(close)
	return n
}
func (p *parser) bindingPattern() *Node {
	t := p.peek(Operand)
	var n *Node
	switch t.Raw {
	case "[", "{":
		p.take(Operand)
		mapping := t.Raw == "{"
		kind, close := "pattern-list", "]"
		if mapping {
			kind, close = "pattern-map", "}"
		}
		n = node(kind, t)
		if !p.atOperand(close) {
			for {
				var item *Node
				if mapping {
					key := p.peek(Operand)
					if key.Kind != Word && key.Kind != Text || key.Kind == Word && key.Raw == "offer" {
						p.fail(key)
					}
					if p.second(Operand).Raw == ":" {
						p.take(Operand)
						p.expect(":")
						item = node("entry", key, p.bindingPattern())
						if key.Kind == Text {
							item.Text = key.Value
						}
					} else {
						name := p.name()
						item = node("entry", name, node("binding", name))
					}
				} else if p.atOperand("...") {
					item = node("rest", p.take(Operand))
					item.Text = ""
					if isName(p.peek(Operand)) && !p.at("as") {
						item.Text = p.name().Raw
					}
				} else {
					item = p.bindingPattern()
				}
				n.Children = append(n.Children, item)
				if !p.accept(",") {
					break
				}
			}
		}
		n.End = p.expect(close)
	case "<":
		n = p.textPattern()
	case "<<":
		n = p.binaryPattern(true)
	case "^":
		p.take(Operand)
		name := p.name()
		n = node("pin", t)
		n.Text = name.Raw
		n.NameToken = name
	case "_":
		n = node("wildcard", p.take(Operand))
	case "-":
		p.take(Operand)
		value := p.peek(Operand)
		if value.Kind != Number {
			p.fail(value)
		}
		n = node("negative-pattern", t, p.primary())
	default:
		if t.Kind == Number || t.Kind == Text || slices.Contains([]string{"true", "false", "nothing"}, t.Raw) {
			n = p.primary()
		} else {
			n = node("binding", p.name())
		}
	}
	if p.at("as") {
		as := p.take(Operand)
		original := n.Token
		n = node("binding-as", original, n)
		n.Flags = append(n.Flags, as)
		alias := p.name()
		n.Text = alias.Raw
		n.NameToken = alias
	}
	return n
}
func (p *parser) textPattern() *Node {
	t := p.peek(Operand)
	p.take(Operand)
	p.depth++
	p.patternDepth++
	n := node("text-pattern", t)
	if !p.at(">") {
		for {
			n.Children = append(n.Children, p.alternation())
			if !p.accept(",") {
				break
			}
		}
	}
	n.End = p.expect(">")
	p.continuation = false
	p.depth--
	p.patternDepth--
	return n
}
func (p *parser) alternation() *Node {
	n := p.element()
	for p.accept("or") {
		t := n.Token
		n = node("pattern-or", t, n, p.element())
	}
	return n
}
func (p *parser) element() *Node {
	n := p.atom()
	for {
		t := p.peek(Operator)
		if p.accept("as") {
			n = node("pattern-convert", t, n, p.kind())
		} else if p.accept("lazily") {
			n = node("pattern-lazy", t, n)
		} else if p.pair("ignoring", "case") {
			p.take(Operator)
			p.expect("case")
			n = node("pattern-fold", t, n)
		} else {
			break
		}
	}
	return n
}
func (p *parser) atom() *Node {
	t := p.peek(Operand)
	if t.Kind == Text {
		p.take(Operand)
		n := node("pattern-text", t)
		n.Text = t.Value
		return n
	}
	if t.Kind == Number {
		p.take(Operand)
		return node("pattern-count", t, p.atom())
	}
	if t.Raw == "<" {
		return p.textPattern()
	}
	if t.Raw == "(" {
		p.take(Operand)
		old := p.patternDepth
		p.patternDepth = 0
		n := node("splice", t, p.expression())
		n.End = p.expect(")")
		p.patternDepth = old
		return n
	}
	if isName(t) && p.second(Operand).Raw == ":" {
		p.take(Operand)
		p.expect(":")
		return node("capture", t, p.alternation())
	}
	if t.Raw == "text" || t.Raw == "line" || t.Raw == "word" {
		second := p.second(Operand)
		if slices.Contains(generated.Grammar.TextPatterns.Anchors, t.Raw+" "+second.Raw) {
			p.take(Operand)
			p.take(Operand)
			n := node("pattern-anchor", t)
			n.Text = t.Raw + " " + second.Raw
			return n
		}
	}
	if t.Raw == "uppercase" || t.Raw == "lowercase" {
		second := p.second(Operand)
		if slices.Contains(generated.Grammar.TextPatterns.Classes, t.Raw+" "+second.Raw) {
			p.take(Operand)
			p.take(Operand)
			n := node("pattern-class", t)
			n.Text = t.Raw + " " + second.Raw
			return n
		}
	}
	if t.Raw == "one" || t.Raw == "zero" {
		p.take(Operand)
		p.expect("or")
		p.expect("more")
		p.expect("of")
		n := node("pattern-repeat", t, p.atom())
		n.Text = t.Raw + " or more of"
		return n
	}
	if t.Raw == "optional" {
		p.take(Operand)
		return node("pattern-repeat", t, p.atom())
	}
	if t.Raw == "a" || t.Raw == "an" {
		p.take(Operand)
		return node("pattern-typed", t, p.kind())
	}
	if slices.Contains(generated.Grammar.TextPatterns.Keywords, t.Raw) {
		return node("pattern-keyword", p.take(Operand))
	}
	p.fail(t)
	return nil
}
func (p *parser) fieldType(n *Node) {
	t := p.peek(Operand)
	if slices.Contains(generated.Grammar.BinaryPatterns.IntegerTypes, t.Raw) {
		n.Text = p.take(Operand).Raw
		if slices.Contains(generated.Grammar.BinaryPatterns.ByteOrders, p.peek(Operand).Raw) {
			n.Text += " " + p.take(Operand).Raw
		}
		return
	}
	var size *Node
	if p.accept("^") {
		size = node("pin", t)
		size.NameToken = p.name()
		size.Text = size.NameToken.Raw
	} else if p.accept("(") {
		p.pinSizeDepth++
		size = node("paren", t, p.expression())
		p.pinSizeDepth--
		size.End = p.expect(")")
	} else if t.Kind == Number {
		size = node("literal", p.take(Operand))
	} else {
		size = node("name", p.name())
	}
	n.Children = append(n.Children, size)
	unit := p.peek(Operand)
	if !slices.Contains(generated.Grammar.BinaryPatterns.SizeUnits, unit.Raw) {
		p.fail(unit)
	}
	p.take(Operand)
	n.Text = unit.Raw
	if n.Text == "byte" {
		n.Text = "bytes"
	}
	if n.Text == "bit" {
		n.Text = "bits"
	}
	if p.accept("as") {
		p.expect("text")
		n.Text += " as text"
	}
}
func (p *parser) binaryPattern(pattern bool) *Node {
	t := p.take(Operand)
	kind := "build"
	if pattern {
		kind = "pattern-binary"
	}
	n := node(kind, t)
	p.buildDepth++
	if !p.atOperand(">>") {
		for {
			token := p.peek(Operand)
			var field *Node
			if pattern {
				if token.Raw == "..." {
					field = node("binary-rest", p.take(Operand))
					field.Text = ""
					if isName(p.peek(Operand)) && !p.at("as") {
						field.Params = []*Node{node("binding", p.name())}
					}
					if p.accept("as") {
						p.expect("text")
						field.Text = "as text"
					}
				} else if token.Kind == Word && p.second(Operand).Raw == ":" {
					p.take(Operand)
					field = node("binary-field", token)
					field.Params = []*Node{node("binding", token)}
					p.expect(":")
					p.fieldType(field)
				} else if token.Kind == Number || token.Kind == Text {
					p.take(Operand)
					field = node("binary-literal", token)
					if token.Kind == Text {
						field.Text = token.Value
					}
				} else {
					p.fail(token)
				}
			} else {
				field = node("build-field", token, p.binary(5))
				field.Text = "value"
				if p.accept("as") {
					p.fieldType(field)
				}
			}
			n.Children = append(n.Children, field)
			if !p.accept(",") {
				break
			}
		}
	}
	n.End = p.expect(">>")
	p.buildDepth--
	return n
}

// Walk visits each syntax node in source order, excluding token trivia.
func Walk(n *Node, visit func(*Node) bool) {
	if n == nil || !visit(n) {
		return
	}
	for _, child := range SourceChildren(n) {
		Walk(child, visit)
	}
}

func HasFlag(n *Node, flag string) bool {
	for _, token := range n.Flags {
		if token.Raw == flag {
			return true
		}
	}
	return false
}
func TextOf(t Token) string {
	if t.Kind == Text {
		return t.Value
	}
	return strings.TrimSpace(t.Raw)
}

// SourceChildren gives the immediate syntax regions in source order.
func SourceChildren(n *Node) []*Node {
	children := []*Node{}
	for _, group := range [][]*Node{n.Params, n.Children, n.Body, n.Branches} {
		children = append(children, group...)
	}
	if n.Guard != nil {
		children = append(children, n.Guard)
	}
	if n.Collect != nil {
		children = append(children, n.Collect)
	}
	sort.SliceStable(children, func(i, j int) bool {
		a, b := children[i].FirstPos(), children[j].FirstPos()
		return a.Line < b.Line || a.Line == b.Line && a.Column < b.Column
	})

	return children
}

func (p *parser) interpolated(t Token) *Node {
	literal := func(value string, pos Position) *Node {
		token := Token{Kind: Text, Value: value, Pos: pos}
		n := node("literal", token)
		n.Text = value
		return n
	}
	result := literal(t.Parts[0].Value, t.Pos)
	for index, part := range t.Parts {
		if part.Hole == nil {
			break
		}
		hole := part.Hole
		lex := &Lexer{source: p.lexer.source, pos: Position{1, 1}}
		lex.advance(hole.Start)
		inner := &parser{lexer: lex, depth: 1, base: []int{0}}
		at := lex.positionAt(hole.At)
		if inner.peek(Operand).Start == hole.End {
			panic(&Error{Code: "empty interpolation", Pos: at})
		}
		expression := inner.expression()
		if inner.peek(Operator).Start != hole.End {
			inner.fail(inner.peek(Operator))
		}
		op := Token{Kind: Punctuator, Raw: "&", Pos: at}
		result = node("binary", op, result, expression)
		if following := t.Parts[index+1].Value; following != "" {
			result = node("binary", op, result, literal(following, at))
		}
	}
	return result
}
