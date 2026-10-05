// Package check resolves the lossless syntax tree into the code-unit and body
// names chapter 8 needs. Diagnostics are ordered by chapter 2's catalogue.
package check

import (
	"fmt"
	"github.com/odogono/odgn-talk/impl/go/internal/generated"
	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
	"github.com/odogono/odgn-talk/impl/go/internal/unicode"
	"math/big"
	"slices"
	"strconv"
	"strings"
)

type Diagnostic struct {
	Message string
	Code    string
	Pos     syntax.Position
}

func (d Diagnostic) String() string {
	return fmt.Sprintf("%s at %d:%d", d.Code, d.Pos.Line, d.Pos.Column)
}

type Symbol struct {
	Kind, Name, Import string
	Index              int
	Node               *syntax.Node
	Required, Maximum  int
	MaySuspend         bool
}
type Options struct {
	Existing *Unit // preceding extension declarations, with stable variable slots

	Library          bool
	Objects          []string
	OwnerProperties  map[string]bool
	ObjectProperties map[string]map[string]bool // property name -> writable, by bound Object name
	ImportCalls      map[string][]OperationUse
	Imports          map[string]map[string]Symbol
	PatternSize      int
	Grants           map[string]map[string]OperationCheck
}
type Body struct {
	Node       *syntax.Node
	Kind, Name string
	Locals     []string
	Captures   []Symbol
	Parent     *Body
	MaySuspend bool
	During     string // the failed-message binding on an error Handler
}

func (b *Body) Slot(name string) int { return slices.Index(b.Locals, name) }

type Unit struct {
	Tree                   *syntax.Tree
	Options                Options
	Symbols                map[string]Symbol
	Definitions, Variables []string
	Bodies                 map[*syntax.Node]*Body
	Diagnostics            []Diagnostic
}

func Builtin(name string) (generated.BuiltinsTableBuiltinEntry, bool) {
	for _, b := range generated.Builtins.Builtin {
		if b.Name == name {
			return b, true
		}
	}
	return generated.BuiltinsTableBuiltinEntry{}, false
}
func (u *Unit) Resolve(body *Body, name string) (Symbol, bool) {
	if body != nil {
		if i := body.Slot(name); i >= 0 {
			return Symbol{Kind: "local", Name: name, Index: i}, true
		}
	}
	if s, ok := u.Symbols[name]; ok {
		return s, true
	}
	if b, ok := Builtin(name); ok {
		kind := "builtin"
		if b.Group == "constants" {
			kind = "builtin-constant"
		}
		return Symbol{Kind: kind, Name: name}, true
	}
	return Symbol{}, false
}
func (u *Unit) add(code string, pos syntax.Position) {
	for _, d := range u.Diagnostics {
		if d.Code == code && d.Pos == pos {
			return
		}
	}
	u.Diagnostics = append(u.Diagnostics, Diagnostic{Code: code, Pos: pos})
}

// A clash belongs to the later name, even when globals were collected first.
func (u *Unit) clash(n *syntax.Node) {
	pos := n.BindingPos()
	if s, ok := u.Symbols[n.Text]; ok && s.Node != nil {
		other := s.Node.BindingPos()
		if other.Line > pos.Line || other.Line == pos.Line && other.Column > pos.Column {
			pos = other
		}
	}
	u.add("name clash", pos)
}
func (u *Unit) declaration(n *syntax.Node, s Symbol) {
	if previous, ok := u.Symbols[s.Name]; ok && !(s.Kind == "handler" && previous.Kind == "handler" && previous.Import == "" && s.Import == "") {
		pos := n.Pos()
		if n.NameToken.Kind == syntax.Word {
			pos = n.NameToken.Pos
		}
		u.add("name clash", pos)
		return
	}
	s.Node = n
	u.Symbols[s.Name] = s
}
func Check(tree *syntax.Tree, options Options) *Unit {
	u := &Unit{Tree: tree, Options: options, Symbols: map[string]Symbol{}, Bodies: map[*syntax.Node]*Body{}}
	if previous := options.Existing; previous != nil {
		for node, body := range previous.Bodies {
			u.Bodies[node] = body
		}
		u.Definitions = slices.Clone(previous.Definitions)
		u.Variables = slices.Clone(previous.Variables)
		for name, symbol := range previous.Symbols {
			for _, body := range previous.Bodies {
				if body.Name == symbol.Name && body.MaySuspend {
					symbol.MaySuspend = true
				}
			}
			u.Symbols[name] = symbol
		}
	}
	if u.Options.PatternSize == 0 {
		for _, l := range generated.Limits.Limit {
			if l.Go == "PatternSize" {
				u.Options.PatternSize = int(l.Default)
			}
		}
	}
	for _, name := range options.Objects {
		u.Symbols[name] = Symbol{Kind: "object", Name: name}
	}
	for _, n := range tree.Declarations {
		switch n.Kind {
		case "constant":
			u.declaration(n, Symbol{Kind: "definition", Name: n.Text, Index: len(u.Definitions)})
			u.Definitions = append(u.Definitions, n.Text)
		case "variable":
			if options.Library {
				u.add("not in a library", n.Pos())
			}
			u.declaration(n, Symbol{Kind: "variable", Name: n.Text, Index: len(u.Variables)})
			u.Variables = append(u.Variables, n.Text)
		case "function", "handler":
			required := 0
			for _, param := range n.Params {
				if len(param.Children) == 0 {
					required++
				}
			}
			u.declaration(n, Symbol{Kind: n.Kind, Name: n.Text, Required: required, Maximum: len(n.Params)})
		case "use":
			library, ok := options.Imports[n.Text]
			if !ok {
				u.add("unknown import", n.BindingPos())
				continue
			}
			for _, param := range n.Params {
				s, ok := library[param.Text]
				if !ok {
					u.add("unknown import", param.Pos())
					continue
				}
				name := param.Text
				if len(n.Children) > 0 {
					name = n.Children[0].Text
				}
				s.Import = n.Text + ":" + param.Text
				s.Name = name
				s.Node = param
				if _, exists := u.Symbols[name]; exists {
					u.add("name clash", param.Pos())
				} else {
					u.Symbols[name] = s
					if s.Kind == "definition" {
						u.Definitions = append(u.Definitions, s.Import)
					}
				}
			}
		}
	}
	initExpressions := []*syntax.Node{}
	for _, n := range tree.Declarations {
		if n.Kind == "constant" || n.Kind == "variable" {
			initExpressions = append(initExpressions, n.Children...)
		}
		if n.Kind == "function" {
			for _, p := range n.Params {
				initExpressions = append(initExpressions, p.Children...)
			}
		}
	}
	initNode := &syntax.Node{Kind: "init", Children: initExpressions}
	u.prepareBody(initNode, nil, "init", "initialiser")
	for _, n := range tree.Declarations {
		if n.Kind == "function" || n.Kind == "handler" {
			u.prepareBody(n, nil, n.Kind, n.Text)
		}
	}
	// Every initializer is checked against only Constants above its declaration.
	available := map[string]bool{}
	if options.Existing != nil {
		for name, symbol := range options.Existing.Symbols {
			if symbol.Kind == "definition" {
				available[name] = true
			}
		}
	}
	for _, n := range tree.Declarations {
		if n.Private && !options.Library {
			u.add("not in a script", n.Pos())
		}
		if n.Kind == "constant" || n.Kind == "variable" {
			for _, e := range n.Children {
				u.validate(e, nil, context{})
				u.constant(e, available)
			}
			if n.Kind == "constant" {
				available[n.Text] = true
			}
		} else if n.Kind == "function" {
			seenDefault := false
			for _, param := range n.Params {
				if len(param.Children) > 0 {
					seenDefault = true
					u.Definitions = append(u.Definitions, n.Text+"."+param.Text)
					u.validate(param.Children[0], nil, context{})
					u.constant(param.Children[0], available)
				} else if seenDefault {
					u.add("default order", param.Pos())
				}
			}
		}
	}
	for _, n := range tree.Declarations {
		if b := u.Bodies[n]; b != nil {
			u.validateBody(b, context{})
		}
	}
	// Suspension is a fixed point over local Handler calls; recursive groups
	// propagate it without depending on declaration or map iteration order.
	changed := true
	for changed {
		changed = false
		for _, n := range tree.Declarations {
			b := u.Bodies[n]
			if b == nil || b.MaySuspend {
				continue
			}
			syntax.Walk(n, func(x *syntax.Node) bool {
				if x != n && x.Kind == "lambda" {
					return false
				}
				if x.Kind == "command" {
					if s, ok := u.Resolve(b, x.Text); ok && s.Kind == "handler" {
						if s.MaySuspend {
							b.MaySuspend = true
						}
						for _, clause := range u.Bodies {
							if clause.Kind == "handler" && clause.Name == s.Name && clause.MaySuspend {
								b.MaySuspend = true
							}
						}
					}
				}
				return true
			})
			if b.MaySuspend {
				changed = true
			}
		}
	}
	u.checkOperations()
	u.checkHandlerWaits()
	u.checkDecisions()
	u.orderDiagnostics()
	u.Options.Existing = nil
	return u
}

// Check after suspension propagation so declaration order and indirect calls
// cannot hide a Suspension Point, including a Join reached through a Handler.
func (u *Unit) checkHandlerWaits() {
	for _, body := range u.Bodies {
		if u.inheritedBody(body) {
			continue
		}
		syntax.Walk(body.Node, func(n *syntax.Node) bool {
			if n != body.Node && n.Kind == "lambda" {
				return false
			}
			if n.Kind != "command" && n.Kind != "call" || n.Kind == "command" && syntax.HasFlag(n, "and") {
				return true
			}
			symbol, ok := u.Resolve(body, n.Text)
			if !ok || symbol.Kind != "handler" {
				return true
			}
			if symbol.MaySuspend {
				if n.Kind == "call" {
					u.add("can't suspend here", n.Pos())
				} else {
					u.add("missing and wait", n.Pos())
				}
				return true
			}
			for _, clause := range u.Bodies {
				if clause.Kind == "handler" && clause.Name == symbol.Name && clause.MaySuspend {
					if n.Kind == "call" {
						u.add("can't suspend here", n.Pos())
					} else {
						u.add("missing and wait", n.Pos())
					}
					break
				}
			}
			return true
		})
	}
}

// InitialiserFailed is the loader/Abstract Machine boundary: the raising
// instruction supplies its source-map position after a successful static check.
func (u *Unit) InitialiserFailed(pos syntax.Position) {
	u.add("initialiser failed", pos)
	u.orderDiagnostics()
}

func (u *Unit) orderDiagnostics() {
	ranks := map[string]int{}
	for i, d := range generated.Diagnostics.Diagnostic {
		ranks[d.Code] = i
	}
	slices.SortStableFunc(u.Diagnostics, func(a, b Diagnostic) int {
		if a.Pos.Line != b.Pos.Line {
			return a.Pos.Line - b.Pos.Line
		}
		if a.Pos.Column != b.Pos.Column {
			return a.Pos.Column - b.Pos.Column
		}
		return ranks[a.Code] - ranks[b.Code]
	})
}

// Bindings enumerates a pattern's names in the source order used for slots,
// temp bindings and moves. Pins and splices read names; they never bind them.
func Bindings(n *syntax.Node) []*syntax.Node {

	var out []*syntax.Node
	var walk func(*syntax.Node)
	walk = func(x *syntax.Node) {
		if x == nil {
			return
		}
		switch x.Kind {
		case "name":
			return
		case "binding", "capture":
			if x.Text != "_" {
				out = append(out, x)
			}
			if x.Kind == "binding" {
				return
			}
		case "rest":
			if x.Text != "" {
				out = append(out, x)
			}
			return
		case "binding-as":
			for _, child := range x.Children {
				walk(child)
			}
			out = append(out, x)
			return
		case "splice", "pin", "literal", "kind":
			return
		}
		for _, param := range x.Params {
			if x.Kind == "binary-field" || x.Kind == "binary-rest" {
				walk(param)
			}
		}
		for _, child := range x.Children {
			walk(child)
		}
	}
	walk(n)
	return out
}
func Root(n *syntax.Node) *syntax.Node {
	for n != nil {
		switch n.Kind {
		case "delimited", "paren":
			n = n.Children[0]
		case "chunk":
			n = n.Children[1]
		case "key", "key-computed":
			n = n.Children[len(n.Children)-1]
		default:
			return n
		}
	}
	return nil
}
func bindingSites(n *syntax.Node, visit func(*syntax.Node)) {
	syntax.Walk(n, func(x *syntax.Node) bool {
		if x != n && x.Kind == "lambda" {
			return false
		}
		switch x.Kind {
		case "put", "add", "subtract":
			visit(Root(x.Children[1]))
		case "multiply", "divide", "delete":
			visit(Root(x.Children[0]))
		case "replace":
			visit(Root(x.Children[1]))
			for _, b := range Bindings(x.Children[0]) {
				visit(b)
			}
		case "let":
			for _, b := range Bindings(x.Children[0]) {
				visit(b)
			}
		case "repeat", "when", "catch", "event":
			for _, param := range x.Params {
				for _, b := range Bindings(param) {
					visit(b)
				}
			}
		case "replace-expression":
			for _, b := range Bindings(x.Children[0]) {
				visit(b)
			}
		}
		return true
	})
}
func (u *Unit) prepareBody(n *syntax.Node, parent *Body, kind, name string) *Body {
	if existing := u.Bodies[n]; existing != nil {
		return existing
	}
	analysisNode := *n
	if kind == "event" {
		analysisNode.Body = nil
		analysisNode.Children = nil
	}
	analysis := &analysisNode
	b := &Body{Node: n, Kind: kind, Name: name, Parent: parent, Locals: []string{"it"}}
	u.Bodies[n] = b
	add := func(x *syntax.Node) {
		if x == nil {
			return
		}
		if x.Text == "it" {
			return
		}
		if _, ok := u.Symbols[x.Text]; ok {
			return
		}
		if parent != nil && x.Kind == "name" && parent.Slot(x.Text) >= 0 {
			return
		}
		if b.Slot(x.Text) < 0 {
			b.Locals = append(b.Locals, x.Text)
		}
	}
	for _, p := range n.Params {
		if p.Kind == "binding" || p.Kind == "name" {
			b.Locals = append(b.Locals, p.Text)
		} else {
			b.Locals = append(b.Locals, fmt.Sprintf("(%d)", len(b.Locals)))
		}
	}
	for _, p := range n.Params {
		if p.Kind != "binding" && p.Kind != "name" {
			for _, name := range Bindings(p) {
				add(name)
			}
		}
	}
	parameterEnd := len(b.Locals)
	// Gather whole-body locals, ordering binding tokens rather than parent nodes.
	var sites []*syntax.Node
	for j := 0; j < len(n.Flags); j++ {
		flag := n.Flags[j]
		if flag.Raw == "during" && j+1 < len(n.Flags) {
			binding := n.Flags[j+1]
			b.During = binding.Raw
			sites = append(sites, &syntax.Node{Kind: "binding", Text: binding.Raw, Token: binding})
			j++
		}
	}
	for _, child := range syntax.SourceChildren(analysis) {
		bindingSites(child, func(site *syntax.Node) {
			if site != nil {
				sites = append(sites, site)
			}
		})
	}
	slices.SortStableFunc(sites, func(a, b *syntax.Node) int {
		x, y := a.BindingPos(), b.BindingPos()
		if x.Line != y.Line {
			return x.Line - y.Line
		}
		return x.Column - y.Column
	})
	for _, site := range sites {
		add(site)
	}
	if parent != nil {
		localEnd := len(b.Locals)
		var captureWalk func(*syntax.Node, map[string]bool)
		captureWalk = func(x *syntax.Node, shadow map[string]bool) {
			if x == nil {
				return
			}
			if x != analysis && x.Kind == "lambda" {
				next := map[string]bool{}
				for k, v := range shadow {
					next[k] = v
				}
				for _, p := range x.Params {
					for _, binding := range Bindings(p) {
						next[binding.Text] = true
					}
				}
				for _, stmt := range x.Body {
					bindingSites(stmt, func(binding *syntax.Node) {
						if binding != nil && binding.Kind != "name" {
							next[binding.Text] = true
						}
					})
				}
				for _, child := range syntax.SourceChildren(x) {
					captureWalk(child, next)
				}
				return
			}
			if (x.Kind == "name" || x.Kind == "pin" || x.Kind == "call" || x.Kind == "literal" && x.Text == "it") && !shadow[x.Text] && b.Slot(x.Text) < 0 {
				if slot := parent.Slot(x.Text); slot >= 0 {
					b.Captures = append(b.Captures, Symbol{Kind: "local", Name: x.Text, Index: slot})
					b.Locals = append(b.Locals, x.Text)
				}
			}
			for _, child := range syntax.SourceChildren(x) {
				captureWalk(child, shadow)
			}
		}
		captureWalk(analysis, map[string]bool{})
		// Captures sit between parameter bindings and the body's other locals.

		captured := append([]string{}, b.Locals[localEnd:]...)
		locals := append([]string{}, b.Locals[parameterEnd:localEnd]...)
		b.Locals = append(append(b.Locals[:parameterEnd], captured...), locals...)
	}
	syntax.Walk(analysis, func(x *syntax.Node) bool {
		if x != analysis && x.Kind == "lambda" {
			u.prepareBody(x, b, "lambda", fmt.Sprintf("%s:%d:%d", name, x.Pos().Line, x.Pos().Column))
			return false
		}
		if x.Kind == "event" && x != analysis {
			if len(x.Params) > 0 || x.Guard != nil {
				u.prepareBody(x, b, "event", x.Text)
			}
			return false
		}
		return true
	})
	return b
}

type context struct {
	loop, finally, join, lambda int
	guard                       bool
	body                        *Body
}

func (u *Unit) validateBody(b *Body, ctx context) {
	ctx.body = b
	if b.Kind == "handler" {
		u.handlerSuffixes(b.Node)
	}
	if b.Kind == "lambda" {
		ctx.lambda++
		ctx.loop = 0
		ctx.finally = 0
		ctx.join = 0
	}
	for _, p := range b.Node.Params {
		if p.Kind != "name" {
			u.pattern(p, b, ctx)
		}
		names := Bindings(p)
		if p.Kind == "name" {
			names = []*syntax.Node{p}
		}
		for _, name := range names {
			if symbol, ok := u.Symbols[name.Text]; ok && symbol.Kind != "builtin" {
				u.clash(name)
			}
		}
	}
	if b.Node.Guard != nil {
		g := ctx
		g.guard = true
		u.validate(b.Node.Guard, b, g)
	}
	if b.Kind == "event" {
		return
	}
	for _, n := range b.Node.Children {
		u.validate(n, b, ctx)
	}
	for _, n := range b.Node.Body {
		u.validate(n, b, ctx)
	}
	for _, n := range b.Node.Branches {
		u.validate(n, b, ctx)
	}
}

func (u *Unit) handlerSuffixes(n *syntax.Node) {
	seen := map[string]bool{}
	for j := 0; j < len(n.Flags); j++ {
		flag := n.Flags[j]
		policy := flag.Raw == "queued" || flag.Raw == "dropping" || flag.Raw == "replacing"
		if seen[flag.Raw] || policy && (seen["queued"] || seen["dropping"] || seen["replacing"]) ||
			flag.Raw == "queued" && seen["deciding"] || flag.Raw == "deciding" && seen["queued"] ||
			flag.Raw == "during" && n.Text != "error" {
			u.add("bad suffixes", flag.Pos)
			return
		}
		seen[flag.Raw] = true
		if flag.Raw != "during" {
			continue
		}
		j++
		binding := n.Flags[j]
		name := &syntax.Node{Kind: "binding", Text: binding.Raw, Token: binding}
		if _, ok := u.Symbols[binding.Raw]; ok {
			u.clash(name)
		}
		for _, param := range n.Params {
			for _, p := range Bindings(param) {
				if p.Text == binding.Raw {
					u.add("duplicate name", binding.Pos)
				}
			}
		}
	}
}
func validNumber(raw string) bool {
	if strings.HasPrefix(raw, "0x") {
		n, ok := new(big.Int).SetString(raw[2:], 16)
		return ok && len(n.String()) <= 34
	}
	parts := strings.Split(raw, ".")
	digits := strings.TrimLeft(strings.Join(parts, ""), "0")
	if len(digits) > 34 {
		return false
	}
	if len(parts[0]) > 34 && len(strings.TrimLeft(parts[0], "0")) > 34 {
		return false
	}
	return len(parts) < 2 || len(parts[1]) <= 6176
}
func knownKind(name string) bool {
	if slices.Contains([]string{"boolean", "text", "number", "quantity", "civil date", "instant", "bytes", "list", "map", "range", "nothing", "pattern", "function", "object", "integer"}, name) {
		return true
	}
	if strings.ContainsAny(name, "*/^") {
		return true
	}
	for _, u := range generated.Units.Unit {
		if name == u.Name || name == u.Plural {
			return true
		}
	}
	return false
}
func convertible(name string) bool {
	return knownKind(name) && !slices.Contains([]string{"boolean", "quantity", "list", "map", "range", "nothing", "pattern", "function", "object", "integer"}, name)
}
func (u *Unit) validate(n *syntax.Node, b *Body, ctx context) {
	if n == nil {
		return
	}
	if n.Kind == "lambda" {
		if ctx.guard {
			u.add("not in a guard", n.Pos())
		}
		u.validateBody(u.Bodies[n], ctx)
		return
	}
	if ctx.guard && n.Kind == "call" {
		s, _ := u.Resolve(b, n.Text)
		if s.Kind != "builtin" {
			u.add("not in a guard", n.Pos())
		}
	}
	if ctx.guard && (n.Kind == "key" || n.Kind == "key-computed") {
		base := unparen(n.Children[len(n.Children)-1])
		s, _ := u.Resolve(b, base.Text)
		if base.Kind == "name" && s.Kind == "object" || base.Kind == "literal" && base.Text == "me" || base.Kind == "target" {
			key, literal := literalKey(n)
			id := literal && key == "id"
			builtin := n.Kind == "key" && slices.Contains(generated.Grammar.Properties, n.Text) && (len(n.Params) == 0 || n.Params[0].Token.Kind != syntax.Text)
			if !id && !builtin {
				u.add("not in a guard", n.Pos())
			}
		}
	}
	if n.Kind == "pass" && ctx.lambda == 0 && b.Kind == "handler" && n.Text != b.Name {
		u.add("wrong message", n.NameToken.Pos)
	}
	if ctx.lambda > 0 && (n.Kind == "pass" || n.Kind == "target") {
		u.add("not in a lambda", n.Pos())
	}
	if ctx.finally > 0 && (slices.Contains([]string{"return", "veto", "pass"}, n.Kind) || (n.Kind == "exit" || n.Kind == "next") && ctx.loop == 0) {
		u.add("leaves finally", n.Pos())
	}
	if ctx.join > 0 && (slices.Contains([]string{"wait", "wait-for", "wait-any", "join", "return", "veto", "pass"}, n.Kind) || n.Kind == "command" && syntax.HasFlag(n, "and") || n.Kind == "call-statement" && syntax.HasFlag(n, "and")) {
		u.add("not in a join", n.Pos())
	}
	if u.Options.Library && (slices.Contains([]string{"wait-for", "wait-any", "join", "send", "pass", "veto", "target"}, n.Kind) || n.Kind == "literal" && n.Text == "me") {
		u.add("not in a library", n.Pos())
	}
	switch n.Kind {
	case "name", "pin":
		if _, ok := u.Resolve(b, n.Text); !ok {
			u.add("unknown name", n.BindingPos())
		} else {
			s, _ := u.Resolve(b, n.Text)
			if n.Kind == "name" && (s.Kind == "handler" || s.Kind == "builtin") {
				u.add("not a value", n.Pos())
			}
		}
	case "literal", "binary-literal":
		if n.Token.Kind == syntax.Number && !validNumber(n.Text) {
			u.add("bad number", n.Pos())
		}
	case "kind":
		if !knownKind(n.Text) {
			u.add("unknown kind", n.Pos())
		}
		return
	case "convert":
		if knownKind(n.Children[1].Text) && !convertible(n.Children[1].Text) {
			u.add("no conversion", n.Pos())
		}
	case "kind-test", "empty-test":
		if len(n.Flags) > 0 {
			u.add("nothing to fold", n.Flags[0].Pos)
		}
	case "map":
		seen := map[string]bool{}
		for _, entry := range n.Children {
			if seen[entry.Text] {
				u.add("duplicate key", entry.Pos())
			}
			seen[entry.Text] = true
		}
	case "call":
		s, ok := u.Resolve(b, n.Text)
		if !ok {
			u.add("unknown name", n.BindingPos())
		} else if s.Kind == "function" && (len(n.Children) < s.Required || len(n.Children) > s.Maximum) {
			u.add("wrong argument count", n.Pos())
		}
	case "put", "add", "subtract", "multiply", "divide", "delete", "replace":
		index := 0
		if slices.Contains([]string{"put", "add", "subtract", "replace"}, n.Kind) {
			index = 1
		}
		root := Root(n.Children[index])
		s, ok := u.Resolve(b, root.Text)
		if ok && (s.Kind == "function" || s.Kind == "handler") {
			u.clash(root)
		}
		if ok && s.Kind == "definition" {
			u.add("can't write", root.Pos())
		}
		if b != nil && b.Kind == "lambda" {
			for _, capture := range b.Captures {
				if capture.Name == root.Text {
					u.add("can't write", root.Pos())
				}
			}
		}
	case "set":
		target := n.Children[0]
		if target.Kind != "key" && target.Kind != "key-computed" {
			u.add("not a property", n.Pos())
		} else {
			base := unparen(target.Children[len(target.Children)-1])
			s, _ := u.Resolve(b, base.Text)
			props, known := u.Options.ObjectProperties[base.Text]
			owner := base.Kind == "literal" && base.Text == "me" && u.Options.OwnerProperties != nil
			if owner {
				props, known = u.Options.OwnerProperties, true
			}
			key, literal := literalKey(target)
			if (owner || base.Kind == "name" && s.Kind == "object") && known && literal && !props[key] {
				u.add("can't write", n.Pos())
			}
		}
	case "delimited":
		hasItem := false
		syntax.Walk(n.Children[0], func(x *syntax.Node) bool {
			if x.Kind == "chunk" && x.Text == "item" || x.Kind == "key" && x.Text == "items" {
				hasItem = true
			}
			return true
		})
		if !hasItem {
			u.add("no item chunk", n.Pos())
		}
	case "text-pattern":
		u.pattern(n, b, ctx)
		return
	case "let":
		u.pattern(n.Children[0], b, ctx)
		u.validate(n.Children[1], b, ctx)
		return
	case "repeat":
		if len(n.Params) > 0 {
			u.pattern(n.Params[0], b, ctx)
		}
		for _, e := range n.Children {
			u.validate(e, b, ctx)
		}
		ctx.loop++
		for _, stmt := range n.Body {
			u.validate(stmt, b, ctx)
		}
		return
	case "exit", "next":
		if ctx.loop == 0 {
			u.add("outside a loop", n.Pos())
		}
	case "when", "catch":
		for _, param := range n.Params {
			u.pattern(param, b, ctx)
		}
		if n.Guard != nil {
			guard := ctx
			guard.guard = true
			u.validate(n.Guard, b, guard)
		}
		for _, stmt := range n.Body {
			u.validate(stmt, b, ctx)
		}
		return
	case "finally":
		ctx.finally++
		ctx.loop = 0
	case "join":
		members := 0
		syntax.Walk(n, func(x *syntax.Node) bool {
			if x != n && x.Kind == "lambda" {
				return false
			}
			if (x.Kind == "ask" || x.Kind == "send") && syntax.HasFlag(x, "and") {
				members++
			}
			return true
		})
		if members == 0 {
			u.add("empty join", n.Pos())
		}
		ctx.join++
	case "build":
		u.bits(n)
	case "command":
		if u.Options.Library && n.Text != "say" {
			if symbol, ok := u.Resolve(b, n.Text); !ok || symbol.Kind != "handler" {
				u.add("not in a library", n.Pos())
			}
		}
		if n.Text == "say" {
			if len(n.Children) != 1 {
				u.add("wrong argument count", n.Pos())
			}
			if syntax.HasFlag(n, "and") {
				u.add("needless and wait", n.Pos())
			}
		}
	}
	if b != nil && (slices.Contains([]string{"wait", "wait-for", "wait-any", "join"}, n.Kind) || ctx.join == 0 && (n.Kind == "send" || n.Kind == "call-statement" || n.Kind == "command") && syntax.HasFlag(n, "and")) {
		b.MaySuspend = true
		if b.Kind == "function" || ctx.finally > 0 {
			u.add("can't suspend here", n.Pos())
		}
	}
	// Message receivers alone may name Scripts that have not been loaded yet.
	if n.Kind == "send" {
		for _, e := range n.Children {
			u.validate(e, b, ctx)
		}
		for _, receiver := range n.Params {
			if receiver.Kind != "name" {
				u.validate(receiver, b, ctx)
			}
		}
		return
	}
	if n.Kind == "event" {
		for _, filter := range n.Children {
			// A bare unresolved receiver Name denotes a Script. Expressions
			// and captures resolve in the enclosing Handler, not the test body.
			if filter.Kind == "name" {
				if _, ok := u.Resolve(b, filter.Text); !ok {
					continue
				}
			}
			u.validate(filter, b, ctx)
		}
		if eventBody := u.Bodies[n]; eventBody != nil {
			u.validateBody(eventBody, ctx)
		}
		for _, stmt := range n.Body {
			u.validate(stmt, b, ctx)
		}
		return
	}
	if n.Kind == "ask" || n.Kind == "tell" {
		for _, e := range n.Children {
			u.validate(e, b, ctx)
		}
		if syntax.HasFlag(n, "and") && b != nil && ctx.join == 0 {
			b.MaySuspend = true
		}
		return
	}
	for _, child := range n.Children {
		u.validate(child, b, ctx)
	}
	for _, child := range n.Body {
		u.validate(child, b, ctx)
	}
	for _, child := range n.Branches {
		u.validate(child, b, ctx)
	}
}
func (u *Unit) constant(n *syntax.Node, available map[string]bool) {
	syntax.Walk(n, func(x *syntax.Node) bool {
		if x.Kind == "name" {
			s, ok := u.Resolve(nil, x.Text)
			if !ok || s.Kind != "builtin-constant" && !available[x.Text] && s.Import == "" {
				u.add("not constant", x.Pos())
			}
		}
		if x.Kind == "call" {
			s, ok := u.Resolve(nil, x.Text)
			if !ok || s.Kind != "builtin" {
				u.add("not constant", x.Pos())
			}
		}
		if x.Kind == "target" || x.Kind == "literal" && (x.Text == "it" || x.Text == "me") {
			u.add("not constant", x.Pos())
			return false
		}
		if x.Kind == "lambda" {
			return false
		}
		return true
	})
}
func (u *Unit) pattern(n *syntax.Node, b *Body, ctx context) {
	seen := map[string]bool{}
	for _, name := range Bindings(n) {
		if _, ok := u.Symbols[name.Text]; ok {
			u.clash(name)
		}
		if seen[name.Text] {
			u.add("duplicate name", name.BindingPos())
		}
		seen[name.Text] = true
	}
	var walk func(*syntax.Node, bool)
	walk = func(x *syntax.Node, repeated bool) {
		if x == nil {
			return
		}
		if x.Kind == "text-pattern" {
			if size, spliced := patternSize(x); !spliced && size+1 > int64(u.Options.PatternSize) {
				u.add("pattern too large", x.Pos())
			}
		}
		if x.Kind == "capture" && repeated {
			u.add("capture in repetition", x.Pos())
		}
		if x.Kind == "pattern-repeat" || x.Kind == "pattern-count" {
			repeated = true
		}
		if x.Kind == "pattern-list" || x.Kind == "pattern-binary" {
			for i, child := range x.Children {
				if (child.Kind == "rest" || child.Kind == "binary-rest") && i != len(x.Children)-1 {
					u.add("rest not last", child.Pos())
				}
			}
		}
		if x.Kind == "pattern-binary" {
			u.bits(x)
			u.binarySizes(x, b, ctx)
		}
		if x.Kind == "pattern-typed" && x.Children[0].Text != "number" {
			u.add("unknown kind", x.Children[0].Pos())
		}
		if x.Kind == "pattern-convert" {
			target := x.Children[1]
			if !knownKind(target.Text) {
				u.add("unknown kind", target.Pos())
			} else if target.Text != "number" || !digitsOnly(x.Children[0]) {
				u.add("no conversion", x.Pos())
			}
		}
		if (x.Kind == "literal" || x.Kind == "binary-literal") && x.Token.Kind == syntax.Number && !validNumber(x.Text) {
			u.add("bad number", x.Pos())
		}
		if x.Kind == "pin" || x.Kind == "splice" {
			u.validate(x, b, ctx)
			return
		}
		for _, child := range x.Children {
			walk(child, repeated)
		}
	}
	walk(n, false)

}
func digitsOnly(n *syntax.Node) bool {
	switch n.Kind {
	case "pattern-keyword":
		return n.Text == "digit" || n.Text == "digits"
	case "pattern-typed":
		return n.Children[0].Text == "number"
	case "pattern-text":
		for _, c := range n.Text {
			if c < '0' || c > '9' {
				return false
			}
		}
		return true
	case "text-pattern", "pattern-or", "capture", "pattern-count", "pattern-repeat", "pattern-lazy", "pattern-fold":
		for _, c := range n.Children {
			if !digitsOnly(c) {
				return false
			}
		}
		return true
	}
	return false
}
func (u *Unit) bits(n *syntax.Node) {
	var first *syntax.Node
	total := 0
	flush := func() {
		if first != nil && total%8 != 0 {
			u.add("bits not whole bytes", first.Pos())
		}
		first = nil
		total = 0
	}
	for _, field := range n.Children {
		if field.Text == "bits" {
			if first == nil {
				first = field
			}
			if len(field.Children) > 0 {
				size := field.Children[len(field.Children)-1]
				width, err := strconv.Atoi(size.Text)
				if err != nil {
					u.add("bits not whole bytes", field.Pos())
				} else {
					total += width
				}
			}
		} else {
			flush()
		}
	}
	flush()
}

const patternSizeCap int64 = 1 << 60

func patternSize(n *syntax.Node) (int64, bool) {
	spliced := false
	sum := int64(0)
	for _, c := range n.Children {
		s, splice := patternSize(c)
		sum = min(patternSizeCap, sum+s)
		spliced = spliced || splice
	}
	switch n.Kind {
	case "text-pattern":
		return sum, spliced
	case "pattern-text":
		b, _ := unicode.Boundaries(n.Text)
		return int64(len(b) - 1), false
	case "splice":
		return 0, true
	case "capture":
		return sum + 2, spliced
	case "pattern-or":
		return sum + 2, spliced
	case "pattern-count":
		base, raw := 10, n.Text
		if strings.HasPrefix(raw, "0x") {
			base, raw = 16, raw[2:]
		}
		count, err := strconv.ParseInt(raw, base, 64)
		if err != nil || count > 1000000000 {
			return 1000000000, spliced
		}
		if count == 0 {
			return 0, spliced
		}
		if len(n.Children) == 1 && n.Children[0].Kind == "pattern-keyword" {
			switch n.Children[0].Text {
			case "characters", "digits", "letters", "spaces":
				sum = 1
			case "words":
				return 2 + max(count-1, 0)*4, false
			}
		}
		if len(n.Children) == 1 && n.Children[0].Kind == "pattern-class" && strings.HasSuffix(n.Children[0].Text, "letters") {
			sum = 1
		}
		if count != 0 && sum > patternSizeCap/count {
			return patternSizeCap, spliced
		}
		return count * sum, spliced
	case "pattern-repeat":
		extra := int64(1)
		if n.Text == "zero or more of" {
			extra = 2
		}
		return sum + extra, spliced
	case "pattern-keyword":
		switch n.Text {
		case "text":
			return 3, false
		case "word", "characters", "digits", "letters", "spaces":
			return 2, false
		case "words":
			return 8, false
		}
		return 1, false
	case "pattern-anchor":
		return 1, false
	case "pattern-class":
		if strings.HasSuffix(n.Text, "letters") {
			return 2, false
		}
		return 1, false
	case "pattern-typed":
		return 8, false
	case "kind":
		return 0, false
	}
	return sum, spliced
}

func (u *Unit) binarySizes(n *syntax.Node, b *Body, ctx context) {
	earlier := map[string]bool{}
	for _, field := range n.Children {
		for _, size := range field.Children {
			u.validate(size, b, ctx)
			syntax.Walk(size, func(x *syntax.Node) bool {
				if x.Kind == "pin" {
					if _, ok := u.Resolve(b, x.Text); !ok {
						u.add("unknown name", x.BindingPos())
					}
					return false
				}
				if x.Kind == "name" && !earlier[x.Text] {
					u.add("unknown name", x.BindingPos())
				}
				return true
			})
		}
		for _, binding := range field.Params {
			if binding.Text != "_" {
				earlier[binding.Text] = true
			}
		}
	}
}

// Inherited bodies retain their original bindings. Only the new Entry is
// checked against the extended name table; inherited metadata remains usable
// for suspension and Decision checks on calls from that Entry.
func (u *Unit) inheritedBody(body *Body) bool {
	if u.Options.Existing == nil {
		return false
	}
	_, inherited := u.Options.Existing.Bodies[body.Node]
	return inherited
}
