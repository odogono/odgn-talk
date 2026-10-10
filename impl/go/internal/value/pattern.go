package value

import (
	"slices"
	"strings"

	"github.com/odogono/odgn-talk/impl/go/internal/decimal"
	"github.com/odogono/odgn-talk/impl/go/internal/generated"
)

type patternNode struct {
	text            string
	digits, capture bool
}
type patternReader struct {
	r        *Reader
	captures map[string]bool
}

func ParsePattern(s string) (Value, error) {
	r := Reader{Text: s}
	p := patternReader{r: &r, captures: map[string]bool{}}
	p.space()
	node, e := p.pattern()
	if e != nil {
		return Value{}, e
	}
	p.space()
	if r.At != len(s) {
		return Value{}, r.Error()
	}
	return Fields{Kind: Pattern, Text: node.text}.Value(), nil
}
func (p *patternReader) space() {
	for p.r.At < len(p.r.Text) && strings.ContainsRune(" \t\r\n", rune(p.r.Text[p.r.At])) {
		p.r.At++
	}
}
func (p *patternReader) word(w string) bool {
	at := p.r.At
	got := p.r.word()
	if got == w {
		return true
	}
	p.r.At = at
	return false
}
func (p *patternReader) pattern() (patternNode, error) {
	if !p.r.Take("<") {
		return patternNode{}, p.r.Error()
	}
	p.space()
	var parts []string
	digits := true
	capture := false
	if !p.r.Take(">") {
		for {
			node, e := p.alternation()
			if e != nil {
				return patternNode{}, e
			}
			if node.text != "<>" {
				parts = append(parts, node.text)
			}
			digits = digits && node.digits
			capture = capture || node.capture
			p.space()
			if p.r.Take(">") {
				break
			}
			if !p.r.Take(",") {
				return patternNode{}, p.r.Error()
			}
			p.space()
		}
	}
	text := strings.Join(parts, ", ")
	if strings.HasPrefix(text, "<") {
		text = " " + text
	}
	return patternNode{"<" + text + ">", digits, capture}, nil
}
func (p *patternReader) alternation() (patternNode, error) {
	node, e := p.element()
	if e != nil {
		return node, e
	}
	for {
		p.space()
		if !p.word("or") {
			return node, nil
		}
		p.space()
		other, e := p.element()
		if e != nil {
			return node, e
		}
		node.text += " or " + other.text
		node.digits = node.digits && other.digits
		node.capture = node.capture || other.capture
	}
}
func (p *patternReader) element() (patternNode, error) {
	node, e := p.atom()
	if e != nil {
		return node, e
	}
	seen := map[string]bool{}
	for {
		p.space()
		suffix := ""
		switch {
		case p.word("as"):
			p.space()
			if !p.word("number") || !node.digits {
				return node, p.r.Error()
			}
			suffix = "as number"
		case p.word("ignoring"):
			p.space()
			if !p.word("case") {
				return node, p.r.Error()
			}
			suffix = "ignoring case"
		case p.word("lazily"):
			suffix = "lazily"
		default:
			for _, s := range []string{"as number", "ignoring case", "lazily"} {
				if seen[s] {
					node.text += " " + s
				}
			}
			return node, nil
		}
		if seen[suffix] {
			return node, p.r.Error()
		}
		seen[suffix] = true
	}
}
func (p *patternReader) atom() (patternNode, error) {
	p.space()
	r := p.r
	if r.peek("<") {
		return p.pattern()
	}
	if r.peek(`"`) || r.peek("(") {
		parenthesized := r.Take("(")
		p.space()
		begin := r.At
		s, e := r.TextValue()
		if e != nil {
			return patternNode{}, e
		}
		if !parenthesized {
			firstEnd := strings.IndexByte(r.Text[begin+1:], '"')
			if firstEnd < 0 || r.At != begin+firstEnd+2 {
				return patternNode{}, r.Error()
			}
		}
		p.space()
		if parenthesized && !r.Take(")") {
			return patternNode{}, r.Error()
		}
		v, e := NewText(s)
		if e != nil {
			return patternNode{}, e
		}
		text := DisplayText(v.Text())
		complex := false
		for _, cp := range v.Text() {
			complex = complex || cp == '"' || hidden(cp)
		}
		if complex {
			text = "(" + text + ")"
		}
		digits := v.Text() != ""
		for _, c := range v.Text() {
			digits = digits && c >= '0' && c <= '9'
		}
		return patternNode{text, digits, false}, nil
	}
	if r.At < len(r.Text) && r.Text[r.At] >= '0' && r.Text[r.At] <= '9' {
		start := r.At
		for r.At < len(r.Text) && strings.ContainsRune("0123456789abcdefABCDEFx.", rune(r.Text[r.At])) {
			r.At++
		}
		n, e := decimal.Parse(r.Text[start:r.At])
		if e != nil {
			return patternNode{}, e
		}
		integer, ok := n.Integer()
		if !ok || integer.Sign() < 0 {
			return patternNode{}, r.Error()
		}
		p.space()
		node, e := p.atom()
		if e != nil {
			return node, e
		}
		if node.capture {
			return node, r.Error()
		}
		node.text = n.String() + " " + node.text
		return node, nil
	}
	word := r.word()
	if word == "" {
		return patternNode{}, r.Error()
	}
	p.space()
	if r.Take(":") {
		if slices.Contains(generated.Grammar.Reserved, word) || p.captures[word] {
			return patternNode{}, r.Error()
		}
		p.captures[word] = true
		p.space()
		node, e := p.alternation()
		node.text = word + ": " + node.text
		node.capture = true
		return node, e
	}
	if word == "one" || word == "zero" {
		for _, w := range []string{"or", "more", "of"} {
			if !p.word(w) {
				return patternNode{}, r.Error()
			}
			p.space()
		}
		node, e := p.atom()
		if e != nil || node.capture {
			return node, r.Error()
		}
		node.text = word + " or more of " + node.text
		return node, nil
	}
	if word == "optional" {
		node, e := p.atom()
		if e != nil || node.capture {
			return node, r.Error()
		}
		node.text = "optional " + node.text
		return node, nil
	}
	if word == "a" || word == "an" {
		if !p.word("number") {
			return patternNode{}, r.Error()
		}
		return patternNode{word + " number", true, false}, nil
	}
	for _, phrase := range append(slices.Clone(generated.Grammar.TextPatterns.Classes), generated.Grammar.TextPatterns.Anchors...) {
		parts := strings.Split(phrase, " ")
		if word == parts[0] && p.word(parts[1]) {
			return patternNode{phrase, false, false}, nil
		}
	}
	if slices.Contains(generated.Grammar.TextPatterns.Keywords, word) {
		return patternNode{word, word == "digit" || word == "digits", false}, nil
	}
	return patternNode{}, r.Error()
}
