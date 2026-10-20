package syntax

import (
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

// The compact parser retains only contiguous marked whole-line comments.
// Lexical line breaks count even when the parser ignores a continuation.
func (p *parser) recordDocumentation(t Token) {
	if t.Kind == LineBreak {
		if text, ok := docLine(t.Leading); p.lineStart && ok {
			p.docLines = append(p.docLines, text)
		} else {
			p.docLines = p.docLines[:0]
		}
		p.lineStart = true
		return
	}
	if len(p.docLines) > 0 {
		if p.docs == nil {
			p.docs = map[int]string{}
		}
		p.docs[t.Start] = strings.Join(p.docLines, "\n")
		p.docLines = p.docLines[:0]
	}
	p.lineStart = false
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
