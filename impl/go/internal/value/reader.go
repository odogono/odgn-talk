package value

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/odogono/odgn-talk/impl/go/internal/decimal"
)

// Reader reads display-form values, not source expressions. Resolve binds
// opaque Host-held Function Values and objects when replay has them available.
type Reader struct {
	Text    string
	At      int
	Resolve func(string) (Value, error)
}

var datePrefix = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}(?:T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z?)?`)
var functionCode = regexp.MustCompile(`^(?:[A-Za-z_][A-Za-z0-9_]*:)?(?:[1-9][0-9]*:[1-9][0-9]*|[A-Za-z_][A-Za-z0-9_]*)$`)
var numberPrefix = regexp.MustCompile(`^-?[0-9]+(?:\.[0-9]+)?`)

func ParseDisplay(s string, resolve func(string) (Value, error)) (Value, error) {
	r := Reader{Text: s, Resolve: resolve}
	v, e := r.Value()
	if e != nil {
		return Value{}, e
	}
	if r.At != len(s) {
		return Value{}, r.Error()
	}
	return v, nil
}
func (r *Reader) Error() error {
	return fmt.Errorf("invalid display form at byte %d: %q", r.At, r.Text[r.At:])
}
func (r *Reader) Take(s string) bool {
	if strings.HasPrefix(r.Text[r.At:], s) {
		r.At += len(s)
		return true
	}
	return false
}
func (r *Reader) peek(s string) bool { return strings.HasPrefix(r.Text[r.At:], s) }
func (r *Reader) word() string {
	start := r.At
	for r.At < len(r.Text) {
		c := r.Text[r.At]
		if c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c == '_' || r.At > start && c >= '0' && c <= '9' {
			r.At++
		} else {
			break
		}
	}
	return r.Text[start:r.At]
}
func (r *Reader) Value() (Value, error) {
	v, e := r.single()
	if e != nil {
		return Value{}, e
	}
	if r.Take("..") {
		w, e := r.single()
		if e != nil {
			return Value{}, e
		}
		return NewRange(v, w)
	}
	return v, nil
}
func (r *Reader) single() (Value, error) {
	if r.At >= len(r.Text) {
		return Value{}, r.Error()
	}
	if r.peek(`"`) || r.peek("quote") || r.peek("newline") || r.peek("tab") || r.peek("fromCodePoint(") {
		s, e := r.TextValue()
		if e != nil {
			return Value{}, e
		}
		return NewText(s)
	}
	if r.Take("nothing") {
		return Value{}, nil
	}
	if r.Take("true") {
		return Value{Kind: Boolean, Bool: true}, nil
	}
	if r.Take("false") {
		return Value{Kind: Boolean}, nil
	}
	if r.Take("<<") {
		var b []byte
		if r.Take(">>") {
			return NewBytes(b), nil
		}
		for {
			if !r.Take("0x") || r.At+2 > len(r.Text) {
				return Value{}, r.Error()
			}
			s := r.Text[r.At : r.At+2]
			for _, c := range s {
				if !(c >= '0' && c <= '9' || c >= 'A' && c <= 'F') {
					return Value{}, r.Error()
				}
			}
			n, _ := strconv.ParseUint(s, 16, 8)
			r.At += 2
			b = append(b, byte(n))
			if r.Take(">>") {
				return NewBytes(b), nil
			}
			if !r.Take(", ") {
				return Value{}, r.Error()
			}
		}
	}
	if r.Take("[") {
		var vs []Value
		if r.Take("]") {
			return NewList(vs), nil
		}
		for {
			v, e := r.Value()
			if e != nil {
				return Value{}, e
			}
			vs = append(vs, v)
			if r.Take("]") {
				return NewList(vs), nil
			}
			if !r.Take(", ") {
				return Value{}, r.Error()
			}
		}
	}
	if r.Take("{") {
		var pairs []Pair
		if r.Take("}") {
			return NewMap(pairs)
		}
		for {
			key := ""
			var e error
			if r.peek(`"`) {
				key, e = r.TextValue()
			} else {
				key = r.word()
				if key == "" {
					e = r.Error()
				}
			}
			if e != nil {
				return Value{}, e
			}
			if !r.Take(": ") {
				return Value{}, r.Error()
			}
			v, e := r.Value()
			if e != nil {
				return Value{}, e
			}
			pairs = append(pairs, Pair{key, v})
			if r.Take("}") {
				return NewMap(pairs)
			}
			if !r.Take(", ") {
				return Value{}, r.Error()
			}
		}
	}
	if r.peek("<object ") {
		start := r.At
		r.Take("<object ")
		kind := r.word()
		if kind == "" || !r.Take(" ") {
			return Value{}, r.Error()
		}
		id, e := r.TextValue()
		if e != nil || !r.Take(">") {
			return Value{}, r.Error()
		}
		display := r.Text[start:r.At]
		if r.Resolve != nil {
			return r.Resolve(display)
		}
		return Value{Kind: Object, Object: &ObjectData{Kind: kind, ID: id, Handle: display}}, nil
	}
	if r.peek("<function ") {
		start := r.At
		r.Take("<function ")
		home := r.word()
		if home == "" {
			return Value{}, r.Error()
		}
		if r.Take("+") {
			begin := r.At
			for r.At < len(r.Text) && r.Text[r.At] >= '0' && r.Text[r.At] <= '9' {
				r.At++
			}
			if begin == r.At {
				return Value{}, r.Error()
			}
			home += r.Text[begin-1 : r.At]
		}
		if !r.Take(":") {
			return Value{}, r.Error()
		}
		codeStart := r.At
		for r.At < len(r.Text) && strings.ContainsRune("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_:", rune(r.Text[r.At])) {
			r.At++
		}
		code := r.Text[codeStart:r.At]
		if !functionCode.MatchString(code) {
			return Value{}, r.Error()
		}
		var captures []Pair
		if r.Take(" ") {
			v, e := r.single()
			if e != nil || v.Kind != Map {
				return Value{}, r.Error()
			}
			captures = v.Entries
		}
		if !r.Take(">") {
			return Value{}, r.Error()
		}
		if r.Resolve != nil {
			return r.Resolve(r.Text[start:r.At])
		}
		return Value{Kind: Function, Function: &FunctionData{Home: home, Code: code, Captures: captures}}, nil
	}
	if r.peek("<") {
		p := patternReader{r: r, captures: map[string]bool{}}
		node, e := p.pattern()
		if e != nil {
			return Value{}, e
		}
		return Value{Kind: Pattern, Text: node.text}, nil
	}
	if s := datePrefix.FindString(r.Text[r.At:]); s != "" {
		r.At += len(s)
		var v Value
		var e error
		if strings.HasSuffix(s, "Z") {
			v, e = ParseInstant(s)
		} else {
			v, e = ParseCivil(s)
		}
		if e == nil && v.Display() != s {
			return Value{}, r.Error()
		}
		return v, e
	}
	s := numberPrefix.FindString(r.Text[r.At:])
	if s == "" {
		return Value{}, r.Error()
	}
	r.At += len(s)
	n, e := decimal.Parse(s)
	if e != nil {
		return Value{}, e
	}
	if n.String() != s {
		return Value{}, r.Error()
	}
	if r.peek(" ") {
		start := r.At + 1
		end := start
		for end < len(r.Text) && strings.ContainsRune("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789*/^", rune(r.Text[end])) {
			end++
		}
		if end > start && (end == len(r.Text) || r.Text[end] != '=') {
			r.At = end
			return NewQuantity(n, r.Text[start:end])
		}
	}
	return Value{Kind: Number, Number: n}, nil
}

// TextValue joins raw code points before normalization, so NFC can compose
// across adjacent pieces exactly as the Host's Text constructor does.
func (r *Reader) TextValue() (string, error) {
	var out strings.Builder
	for {
		switch {
		case r.Take(`"`):
			start := r.At
			for r.At < len(r.Text) && r.Text[r.At] != '"' {
				cp, size := utf8.DecodeRuneInString(r.Text[r.At:])
				if cp == utf8.RuneError && size == 1 || hidden(cp) {
					return "", r.Error()
				}
				r.At += size
			}
			if r.At == len(r.Text) {
				return "", r.Error()
			}
			out.WriteString(r.Text[start:r.At])
			r.At++
		case r.Take("quote"):
			out.WriteByte('"')
		case r.Take("newline"):
			out.WriteByte('\n')
		case r.Take("tab"):
			out.WriteByte('\t')
		case r.Take("fromCodePoint("):
			start := r.At
			for r.At < len(r.Text) && r.Text[r.At] >= '0' && r.Text[r.At] <= '9' {
				r.At++
			}
			if start == r.At || !r.Take(")") {
				return "", r.Error()
			}
			n, e := strconv.ParseUint(r.Text[start:r.At-1], 10, 32)
			if e != nil || n > utf8.MaxRune || n >= 0xd800 && n <= 0xdfff {
				return "", r.Error()
			}
			out.WriteRune(rune(n))
		default:
			return "", r.Error()
		}
		if !r.Take(" & ") {
			return out.String(), nil
		}
	}
}
