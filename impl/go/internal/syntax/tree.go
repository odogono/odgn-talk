package syntax

import "strings"

// Node is the Core's syntax form, independent of any tooling tree. Children
// hold operands, entries or fields; Params, Body, Branches and Guard preserve
// the grammar's distinct regions. Token and End retain their source positions.
type Node struct {
	NameToken                        Token
	Kind                             string
	Text                             string
	Token, End                       Token
	Children, Params, Body, Branches []*Node
	Guard                            *Node
	Flags                            []Token
	HasElse                          bool
	Private                          bool
}

func (n *Node) Pos() Position { return n.Token.Pos }

type Tree struct {
	Declarations []*Node
	Tokens       []Token
}

// Source reconstructs the exact UTF-8 source, including every comment, line
// break, continuation and the ignored initial BOM.
func (t *Tree) Source() string {
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
	pos := n.Pos()
	for _, child := range n.Children {
		p := child.FirstPos()
		if p.Line < pos.Line || p.Line == pos.Line && p.Column < pos.Column {
			pos = p
		}
	}
	return pos
}

func (n *Node) BindingPos() Position {
	if n.NameToken.Kind == Word {
		return n.NameToken.Pos
	}
	return n.Pos()
}
