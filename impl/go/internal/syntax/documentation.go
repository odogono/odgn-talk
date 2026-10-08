package syntax

import (
	"slices"
	"sort"
	"strings"
)

// docMarker starts a line comment that documents the declaration after it.
const docMarker = "--|"

// docLine gives a whole-line comment's documentation text when the comment is
// marked: the marker and at most one following ASCII space are removed.
func docLine(leading string) (string, bool) {
	s := strings.TrimLeft(strings.TrimPrefix(leading, "\ufeff"), " \t")
	if !strings.HasPrefix(s, docMarker) {
		return "", false
	}
	return strings.TrimPrefix(s[len(docMarker):], " "), true
}

// docBlock collects the marked whole-line comments directly before
// tokens[at]. A line holds only a comment when its line break follows another
// line break or starts the source; a blank line or ordinary comment ends it.
func docBlock(tokens []Token, at int) []string {
	var lines []string
	for k := at - 1; k >= 0 && tokens[k].Kind == LineBreak && (k == 0 || tokens[k-1].Kind == LineBreak); k-- {
		text, ok := docLine(tokens[k].Leading)
		if !ok {
			break
		}
		lines = append(lines, text)
	}
	slices.Reverse(lines)
	return lines
}

// Documentation is a declaration's Declaration Documentation: the block of
// `--|` lines directly before it, joined with LF. Imports have none, and a
// declaration without a block has empty text.
func (t *Tree) Documentation(n *Node) string {
	if n.Kind == "use" {
		return ""
	}
	at := sort.Search(len(t.Tokens), func(i int) bool { return t.Tokens[i].Start >= n.Token.Start })
	if at == len(t.Tokens) || t.Tokens[at].Start != n.Token.Start {
		return ""
	}
	return strings.Join(docBlock(t.Tokens, at), "\n")
}

// EntryDoc is how an Entry's leading documentation block attaches.
type EntryDoc uint8

const (
	// DocNone: the Entry's first token has no block directly before it.
	DocNone EntryDoc = iota
	// DocPending: the input ends with a block that nothing has followed yet.
	DocPending
	// DocAttached: a block directly precedes the Entry's first token.
	DocAttached
)

// LeadingDoc classifies the block of `--|` lines before an Entry's first
// token. A blank line or an ordinary comment after a block detaches it.
func LeadingDoc(source string) EntryDoc {
	l, err := NewLexer(source)
	if err != nil {
		return DocNone
	}
	var tokens []Token
	for {
		t, err := l.Next(Operand)
		if err != nil {
			return DocNone
		}
		tokens = append(tokens, t)
		if t.Kind != LineBreak {
			break
		}
	}
	last := len(tokens) - 1
	if tokens[last].Kind == EOF {
		// A final comment line without its line break is in the EOF's leading text.
		if strings.TrimLeft(strings.TrimPrefix(tokens[last].Leading, "\ufeff"), " \t") != "" {
			if _, ok := docLine(tokens[last].Leading); ok {
				return DocPending
			}
			return DocNone
		}
		if len(docBlock(tokens, last)) > 0 {
			return DocPending
		}
		return DocNone
	}
	if len(docBlock(tokens, last)) > 0 {
		return DocAttached
	}
	return DocNone
}
