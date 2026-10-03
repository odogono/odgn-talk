package syntax

import (
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/odogono/odgn-talk/impl/go/internal/generated"
	"github.com/odogono/odgn-talk/impl/go/internal/unicode"
)

// Position counts lines and Unicode scalars from one, including tabs and the
// ignored initial BOM. Offsets in Token instead count UTF-8 bytes (chapter 1).
type Position struct{ Line, Column int }

type Error struct {
	Code string
	Pos  Position
}

func (e *Error) Error() string { return fmt.Sprintf("%s at %d:%d", e.Code, e.Pos.Line, e.Pos.Column) }

type Kind uint8

const (
	EOF Kind = iota
	Word
	Number
	Text
	Unit
	Punctuator
	LineBreak
)

// Mode is supplied by the predictive parser before scanning a token. Newlines
// are always returned; the parser decides whether a line continues.
type Mode uint8

const (
	Operand Mode = iota
	Operator
	Pattern
	AfterNumber
	AfterAs
)

// Token retains every source byte in Leading and Raw. Value differs from Raw
// only for a Text token: it is the unquoted, pinned NFC value.
type Token struct {
	Kind                Kind
	Raw, Leading, Value string
	Start, End          int
	Pos                 Position
}

type Lexer struct {
	source string
	offset int
	pos    Position
	err    error
}

func NewLexer(source string) (*Lexer, error) {
	if !utf8.ValidString(source) {
		return nil, errors.New("invalid value: source is not valid UTF-8")
	}
	return &Lexer{source: source, pos: Position{1, 1}}, nil
}

func letter(c byte) bool    { return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' }
func digit(c byte) bool     { return c >= '0' && c <= '9' }
func wordStart(c byte) bool { return letter(c) || c == '_' }
func wordPart(c byte) bool  { return wordStart(c) || digit(c) }
func hex(c byte) bool       { return digit(c) || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F' }

func (l *Lexer) advance(end int) {
	for l.offset < end {
		c, size := utf8.DecodeRuneInString(l.source[l.offset:])
		l.offset += size
		if c == '\r' {
			if l.offset < end && l.source[l.offset] == '\n' {
				l.offset++
			}
			l.pos.Line++
			l.pos.Column = 1
		} else if c == '\n' {
			l.pos.Line++
			l.pos.Column = 1
		} else {
			l.pos.Column++
		}
	}
}

func (l *Lexer) fail(code string, pos Position) (Token, error) {
	l.err = &Error{code, pos}
	return Token{}, l.err
}

func (l *Lexer) Next(mode Mode) (Token, error) {
	if l.err != nil {
		return Token{}, l.err
	}
	leading := l.offset
	if l.offset == 0 && strings.HasPrefix(l.source, "\ufeff") {
		l.advance(3)
	}
	for l.offset < len(l.source) {
		s := l.source[l.offset:]
		if s[0] == ' ' || s[0] == '\t' {
			l.advance(l.offset + 1)
			continue
		}
		if strings.HasPrefix(s, "--") {
			end := l.offset + 2
			for end < len(l.source) && l.source[end] != '\r' && l.source[end] != '\n' {
				end++
			}
			l.advance(end)
			continue
		}
		break
	}
	start, pos := l.offset, l.pos
	token := Token{Leading: l.source[leading:start], Start: start, End: start, Pos: pos, Kind: EOF}
	if start == len(l.source) {
		return token, nil
	}
	s := l.source[start:]
	end, kind := start+1, Punctuator
	if mode == AfterNumber || mode == AfterAs {
		unitEnd, starts, err := scanUnit(s, mode)
		if err {
			return l.fail("bad unit", pos)
		}
		if starts {
			end, kind = start+unitEnd, Unit
			goto done
		}
	}
	switch {
	case s[0] == '\r' || s[0] == '\n':
		kind = LineBreak
		if strings.HasPrefix(s, "\r\n") {
			end++
		}
	case wordStart(s[0]):
		kind = Word
		for end < len(l.source) && wordPart(l.source[end]) {
			end++
		}
	case digit(s[0]):
		kind = Number
		if len(s) > 2 && strings.HasPrefix(s, "0x") && hex(s[2]) {
			end = start + 3
			for end < len(l.source) && hex(l.source[end]) {
				end++
			}
		} else {
			for end < len(l.source) && digit(l.source[end]) {
				end++
			}
			if end+1 < len(l.source) && l.source[end] == '.' && digit(l.source[end+1]) {
				end += 2
				for end < len(l.source) && digit(l.source[end]) {
					end++
				}
			}
		}
	case s[0] == '"':
		kind = Text
		for end < len(l.source) && l.source[end] != '"' && l.source[end] != '\r' && l.source[end] != '\n' {
			end++
		}
		if end == len(l.source) || l.source[end] != '"' {
			return l.fail("unterminated text", pos)
		}
		end++
		token.Value, _ = unicode.NFC(l.source[start+1 : end-1])
	case s[0] == '\'':
		if len(s) < 2 || s[1] != 's' || len(s) > 2 && wordPart(s[2]) {
			return l.fail("bad character", pos)
		}
		end++
	default:
		found := false
		for _, punct := range []string{"...", "..", "<=", ">=", "<>", "<<", ">>"} {
			if mode == Operand && (punct == "<>" || punct == "<=") {
				continue
			}
			if mode == Pattern && (punct == "<<" || punct == ">>" || punct == "<=" || punct == "<>" || punct == ">=") {
				continue
			}
			if strings.HasPrefix(s, punct) {
				end = start + len(punct)
				found = true
				break
			}
		}
		if !found && !strings.ContainsRune("&=<>+-*/^()[]{},:", rune(s[0])) {
			return l.fail("bad character", pos)
		}
	}
done:
	token.Kind, token.Raw, token.End = kind, l.source[start:end], end
	l.advance(end)
	return token, nil
}

func unitFor(name string) (generated.UnitsTableUnitEntry, bool) {
	for _, unit := range generated.Units.Unit {
		if unit.Name == name || unit.Plural != "" && unit.Plural == name {
			return unit, true
		}
	}
	return generated.UnitsTableUnitEntry{}, false
}

// scanUnit consumes the contiguous Unit shape before validating every factor.
// Repeated factors are permitted only when they name the same Unit, not merely
// the same Unit Kind. Calendar Units must stand alone (chapter 1).
func scanUnit(s string, mode Mode) (end int, starts, bad bool) {
	i := 0
	if strings.HasPrefix(s, "1/") {
		i = 2
		starts = true
	}
	first := i
	for i < len(s) && letter(s[i]) {
		i++
	}
	if !starts && i < len(s) && wordPart(s[i]) {
		return 0, false, false
	}
	if !starts {
		_, starts = unitFor(s[first:i])
	}
	if !starts {
		return 0, false, false
	}
	compound := first != 0 || i < len(s) && strings.ContainsRune("*/^", rune(s[i]))
	if mode == AfterAs && !compound {
		return 0, false, false
	}
	// Operators, signs and digits are included here only as Unit syntax, so
	// malformed exponents and separators fail at the beginning of the Unit.
	end = i
	for end < len(s) {
		if s[end] != '*' && s[end] != '/' && s[end] != '^' {
			break
		}
		symbol := s[end]
		end++
		if symbol == '^' {
			if end < len(s) && (s[end] == '+' || s[end] == '-') {
				end++
			}
			for end < len(s) && digit(s[end]) {
				end++
			}
		} else {
			for end < len(s) && letter(s[end]) {
				end++
			}
		}
	}
	if first != 0 && i == first {
		return end, true, true
	}
	shape := s[:end]
	i, slashes, factors := 0, 0, 0
	if first != 0 {
		i = 2
		slashes = 1
	}
	seen := map[string]string{}
	calendar := false
	for i < len(shape) {
		begin := i
		for i < len(shape) && letter(shape[i]) {
			i++
		}
		unit, ok := unitFor(shape[begin:i])
		if !ok {
			return end, true, true
		}
		if prior, exists := seen[unit.Kind]; exists && prior != unit.Name {
			return end, true, true
		}
		seen[unit.Kind] = unit.Name
		for _, kind := range generated.Units.Kind {
			if kind.Name == unit.Kind && kind.Calendar {
				calendar = true
			}
		}
		factors++
		if i < len(shape) && shape[i] == '^' {
			if calendar {
				return end, true, true
			}
			i++
			if i == len(shape) || shape[i] < '1' || shape[i] > '9' {
				return end, true, true
			}
			for i < len(shape) && digit(shape[i]) {
				i++
			}
		}
		if i == len(shape) {
			break
		}
		if shape[i] != '*' && shape[i] != '/' {
			return end, true, true
		}
		if shape[i] == '/' {
			slashes++
			if slashes > 1 {
				return end, true, true
			}
		}
		i++
		if i == len(shape) {
			return end, true, true
		}
	}
	return end, true, calendar && (factors != 1 || first != 0)
}
