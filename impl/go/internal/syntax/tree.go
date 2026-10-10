package syntax

import "strings"

// Node is the Core's syntax form, independent of any tooling tree. Children
// hold operands, entries or fields; Params, Body, Branches, Guard and Collect preserve
// the grammar's distinct regions. Token and End retain their source positions.
type Node struct {
	// NameToken is optional; most expression nodes have no binding name.
	NameToken                        *Token
	Kind                             string
	Text                             string
	Token, End                       Token
	Children, Params, Body, Branches []*Node
	Guard, Collect                   *Node
	Flags                            []Token
	HasElse                          bool
	Private                          bool
	first                            Position
}

func (n *Node) Pos() Position { return n.Token.Pos }

type Tree struct {
	Declarations []*Node
	Tokens       []Token
	source       *string
	docs         map[int]string
}

// Source reconstructs the exact UTF-8 source, including every comment, line
// break, continuation and the ignored initial BOM.
func (t *Tree) Source() string {
	if t.source != nil {
		return *t.source
	}
	var out strings.Builder
	for _, token := range t.Tokens {
		out.WriteString(token.Leading)
		out.WriteString(token.Raw)
	}
	return out.String()
}

// FirstPos places a Guard at its first source token, while Pos places an
// operator at its own token for that operator's instructions.
func (n *Node) FirstPos() Position {
	if n.first.Line != 0 {
		return n.first
	}
	pos := n.Pos()
	pending := append([]*Node(nil), n.Children...)
	for len(pending) > 0 {
		child := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		p := child.first
		if p.Line == 0 {
			p = child.Pos()
			pending = append(pending, child.Children...)
		}
		if p.Line < pos.Line || p.Line == pos.Line && p.Column < pos.Column {
			pos = p
		}
	}
	return pos
}

// Cache after parsing has finished mutating children, before a tree is shared
// by compilation caches. FirstPos stays read-only for concurrent readers.
func (n *Node) cachePositions() {
	type pending struct {
		node *Node
		exit bool
	}
	stack := []pending{{node: n}}
	for len(stack) > 0 {
		item := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		n := item.node
		if n == nil || n.first.Line != 0 {
			continue
		}
		if item.exit {
			n.first = n.FirstPos()
			continue
		}
		stack = append(stack, pending{node: n, exit: true})
		for _, group := range [][]*Node{n.Children, n.Params, n.Body, n.Branches} {
			for _, child := range group {
				stack = append(stack, pending{node: child})
			}
		}
		if n.Guard != nil {
			stack = append(stack, pending{node: n.Guard})
		}
		if n.Collect != nil {
			stack = append(stack, pending{node: n.Collect})
		}
	}
}

func (n *Node) BindingPos() Position {
	if n.NameToken != nil && n.NameToken.Kind == Word {
		return n.NameToken.Pos
	}
	return n.Pos()
}
