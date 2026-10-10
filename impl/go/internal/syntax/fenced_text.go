package syntax

import (
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/odogono/odgn-talk/impl/go/internal/unicode"
)

type TextPart struct {
	Start, End int
	Value      string
	Hole       *TextHole
}
type TextHole struct{ At, Start, End int }

func (l *Lexer) positionAt(at int) Position {
	copy := &Lexer{source: l.source, pos: Position{1, 1}}
	copy.advance(at)
	return copy.pos
}

// scanFenced keeps source offsets separate from cooked text, including through
// margins, CRLF normalization, escapes and nested interpolation expressions.
func (l *Lexer) scanFenced(open int) (Token, error) {
	if l.nesting >= MaxNesting {
		return Token{}, nestingError(l.positionAt(open))
	}
	s := l.source
	raw := s[open] == '"'
	width := 1
	if raw {
		for open+width < len(s) && s[open+width] == '"' {
			width++
		}
	}
	begin := open + width
	block := begin < len(s) && (s[begin] == '\r' || s[begin] == '\n')
	parts := []TextPart{}
	start, i := begin, begin
	earlier := func(at int) []TextHole {
		holes := []TextHole{}
		for _, part := range parts {
			if part.Hole != nil && part.Hole.End < at {
				holes = append(holes, *part.Hole)
			}
		}
		return holes
	}
	fail := func(code string, at int) (Token, error) {
		holes := earlier(at)
		if strings.HasPrefix(code, "unterminated") {
			holes = nil
		}
		return Token{}, &Error{Code: code, Pos: l.positionAt(at), Earlier: holes, Incomplete: strings.HasPrefix(code, "unterminated")}
	}
	for i < len(s) {
		if (!raw && s[i] == '`') || (raw && s[i] == '"') {
			count := 1
			if raw {
				for i+count < len(s) && s[i+count] == '"' {
					count++
				}
			}
			if raw && count > width {
				return fail("invalid text delimiter", i)
			}
			if count == width {
				break
			}
			i += count
			continue
		}
		if !raw && s[i] == '\\' {
			i++
			if i < len(s) && s[i] == '\r' && i+1 < len(s) && s[i+1] == '\n' {
				i++
			}
			if i < len(s) {
				_, size := utf8.DecodeRuneInString(s[i:])
				i += size
			}
			continue
		}
		if !raw && strings.HasPrefix(s[i:], "${") {
			at := i
			inner := &Lexer{source: s, pos: Position{1, 1}, nesting: l.nesting + 1}
			inner.advance(i + 2)
			depth := 0
			for {
				t, err := inner.Next(Operand)
				if err != nil {
					if e, ok := err.(*Error); ok && !strings.HasPrefix(e.Code, "unterminated") {
						e.Earlier = append(earlier(at), e.Earlier...)
					}
					return Token{}, err
				}
				if t.Kind == EOF {
					return fail("unterminated interpolation", at)
				}
				if t.Kind == Punctuator && t.Raw == "}" && depth == 0 {
					parts = append(parts, TextPart{Start: start, End: at, Hole: &TextHole{at, at + 2, t.Start}})
					i = t.End
					start = i
					break
				}
				if t.Kind == Punctuator && t.Raw == "{" {
					depth++
				}
				if t.Kind == Punctuator && t.Raw == "}" {
					depth--
				}
			}
			continue
		}
		i++
	}
	if i >= len(s) {
		return fail("unterminated text", open)
	}
	parts = append(parts, TextPart{Start: start, End: i})
	margin := ""
	closeLine := i
	if block {
		for closeLine > 0 && s[closeLine-1] != '\n' && s[closeLine-1] != '\r' {
			closeLine--
		}
		margin = s[closeLine:i]
		if suffix := strings.TrimLeft(margin, " \t"); suffix != "" {
			return fail("invalid text indentation", i-len(suffix))
		}
	}
	for index := range parts {
		part := &parts[index]
		from, to := part.Start, part.End
		if block && from == begin {
			if s[from] == '\r' && from+1 < len(s) && s[from+1] == '\n' {
				from += 2
			} else {
				from++
			}
		}
		if block && to == i {
			to = closeLine
			if to > from && s[to-1] == '\n' {
				to--
			}
			if to > from && s[to-1] == '\r' {
				to--
			}
		}
		bytes := []byte{}
		positions := []int{}
		for j := from; j < to; {
			if block && (j == 0 || s[j-1] == '\n' || s[j-1] == '\r') {
				k := 0
				for k < len(margin) && j+k < to && s[j+k] == margin[k] {
					k++
				}
				if k != len(margin) {
					blank := j+k < len(s) && (s[j+k] == '\n' || s[j+k] == '\r') || j+k == to && part.Hole == nil
					if !blank {
						return fail("invalid text indentation", j+k)
					}
				}
				j += k
				if j >= to {
					break
				}
			}
			positions = append(positions, j)
			if s[j] == '\r' {
				bytes = append(bytes, '\n')
				if j+1 < len(s) && s[j+1] == '\n' {
					j += 2
				} else {
					j++
				}
			} else {
				bytes = append(bytes, s[j])
				j++
			}
		}
		value := string(bytes)
		if !raw {
			cooked, at, ok := decodeTemplate(value, positions)
			if !ok {
				return fail("invalid text escape", at)
			}
			value = cooked
		}
		part.Value, _ = unicode.NFC(value)
	}
	kind := Text
	if len(parts) > 1 {
		kind = Template
	}
	return Token{Kind: kind, Raw: s[open : i+width], Value: parts[0].Value, Start: open, End: i + width, Pos: l.positionAt(open), Parts: parts}, nil
}

func decodeTemplate(s string, positions []int) (string, int, bool) {
	values := []rune{}
	origins := []int{}
	add := func(r rune, at int) { values = append(values, r); origins = append(origins, at) }
	for i := 0; i < len(s); i++ {
		at := positions[i]
		if s[i] != '\\' {
			r, size := utf8.DecodeRuneInString(s[i:])
			add(r, at)
			i += size - 1
			continue
		}
		i++
		if i >= len(s) {
			return "", at, false
		}
		c := s[i]
		switch c {
		case '\n':
			continue
		case '0':
			if i+1 < len(s) && digit(s[i+1]) {
				return "", at, false
			}
			add(0, at)
			continue
		case 'b':
			add('\b', at)
			continue
		case 'f':
			add('\f', at)
			continue
		case 'n':
			add('\n', at)
			continue
		case 'r':
			add('\r', at)
			continue
		case 't':
			add('\t', at)
			continue
		case 'v':
			add('\v', at)
			continue
		}
		if c >= '1' && c <= '9' {
			return "", at, false
		}
		if c == 'x' || c == 'u' {
			digits := ""
			if c == 'u' && i+1 < len(s) && s[i+1] == '{' {
				end := strings.IndexByte(s[i+2:], '}')
				if end < 0 {
					return "", at, false
				}
				end += i + 2
				digits = s[i+2 : end]
				i = end
			} else {
				count := 4
				if c == 'x' {
					count = 2
				}
				if i+count >= len(s) {
					return "", at, false
				}
				digits = s[i+1 : i+1+count]
				i += count
			}
			if digits == "" {
				return "", at, false
			}
			for j := range len(digits) {
				if !hex(digits[j]) {
					return "", at, false
				}
			}
			n, err := strconv.ParseUint(digits, 16, 32)
			if err != nil || n > utf8.MaxRune {
				return "", at, false
			}
			add(rune(n), at)
			continue
		}
		r, size := utf8.DecodeRuneInString(s[i:])
		i += size - 1
		if r != 0x2028 && r != 0x2029 {
			add(r, at)
		}
	}
	out := []rune{}
	for i := 0; i < len(values); i++ {
		r := values[i]
		if r >= 0xd800 && r <= 0xdbff && i+1 < len(values) && values[i+1] >= 0xdc00 && values[i+1] <= 0xdfff {
			out = append(out, utf16.DecodeRune(r, values[i+1]))
			i++
			continue
		}
		if r >= 0xd800 && r <= 0xdfff {
			return "", origins[i], false
		}
		out = append(out, r)
	}
	return string(out), 0, true
}
