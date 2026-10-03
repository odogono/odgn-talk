package value

import (
	"encoding/base64"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/odogono/odgn-talk/impl/go/internal/decimal"
)

type EncodingError struct {
	Kind Kind
	Path []Value
}

func (e *EncodingError) Error() string { return "not encodable: " + KindNames[e.Kind] }

// JSONString follows the two Spec escape rules, both of which leave all
// non-control Unicode scalars and HTML characters as raw UTF-8.
func JSONString(s string, plain bool) string {
	var out strings.Builder
	out.WriteByte('"')
	for _, cp := range s {
		switch {
		case cp == '"' || cp == '\\':
			out.WriteByte('\\')
			out.WriteRune(cp)
		case cp < 0x20:
			short := map[rune]byte{'\b': 'b', '\t': 't', '\n': 'n', '\f': 'f', '\r': 'r'}
			if ch, ok := short[cp]; plain && ok {
				out.WriteByte('\\')
				out.WriteByte(ch)
			} else {
				fmt.Fprintf(&out, "\\u%04x", cp)
			}
		default:
			out.WriteRune(cp)
		}
	}
	out.WriteByte('"')
	return out.String()
}
func Encode(v Value, plain bool) ([]byte, error) {
	var out strings.Builder
	err := encode(&out, v, plain, nil)
	if err != nil {
		return nil, err
	}
	return []byte(out.String()), nil
}
func encode(out *strings.Builder, v Value, plain bool, path []Value) error {
	str := func(s string) { out.WriteString(JSONString(s, plain)) }
	tag := func(name, s string) { out.WriteString(`{"` + name + `":`); str(s); out.WriteByte('}') }
	switch v.Kind {
	case Nothing:
		out.WriteString("null")
	case Boolean:
		out.WriteString(strconv.FormatBool(v.Bool))
	case Number:
		n := v.Number.String()
		integer, integerError := v.Number.Int64()
		if plain || v.Number.Exponent() == 0 && integerError == nil && integer > -9007199254740992 && integer < 9007199254740992 {
			out.WriteString(n)
		} else {
			tag("$dec", n)
		}
	case Text:
		str(v.Text)
	case List:
		out.WriteByte('[')
		for i, item := range v.Items {
			if i > 0 {
				out.WriteByte(',')
			}
			next := appendPath(path, Value{Kind: Number, Number: decimal.FromInt(int64(i + 1))})
			if e := encode(out, item, plain, next); e != nil {
				return e
			}
		}
		out.WriteByte(']')
	case Map:
		wrapped := false
		for _, p := range v.Entries {
			if strings.HasPrefix(p.Key, "$") && !plain {
				wrapped = true
				break
			}
		}
		if wrapped {
			out.WriteString(`{"$map":[`)
		} else {
			out.WriteByte('{')
		}
		for i, p := range v.Entries {
			if i > 0 {
				out.WriteByte(',')
			}
			if wrapped {
				out.WriteByte('[')
			}
			str(p.Key)
			if wrapped {
				out.WriteByte(',')
			} else {
				out.WriteByte(':')
			}
			if e := encode(out, p.Val, plain, appendPath(path, Value{Kind: Text, Text: p.Key})); e != nil {
				return e
			}
			if wrapped {
				out.WriteByte(']')
			}
		}
		if wrapped {
			out.WriteString("]}")
		} else {
			out.WriteByte('}')
		}
	default:
		if plain || v.Kind == Function {
			return &EncodingError{v.Kind, append([]Value(nil), path...)}
		}
		switch v.Kind {
		case Bytes:
			tag("$bytes", base64.StdEncoding.EncodeToString(v.Bytes))
		case Quantity:
			out.WriteString(`{"$quantity":[`)
			str(v.Number.String())
			out.WriteByte(',')
			str(v.Unit.String())
			out.WriteString("]}")
		case Range:
			out.WriteString(`{"$range":[`)
			if e := encode(out, v.Items[0], false, path); e != nil {
				return e
			}
			out.WriteByte(',')
			if e := encode(out, v.Items[1], false, path); e != nil {
				return e
			}
			out.WriteString("]}")
		case Instant:
			tag("$instant", v.Display())
		case CivilDate:
			tag("$date", v.Display())
		case Pattern:
			tag("$pattern", v.Text)
		case Object:
			out.WriteString(`{"$object":[`)
			str(v.Object.Kind)
			out.WriteByte(',')
			str(v.Object.ID)
			out.WriteString("]}")
		default:
			return fmt.Errorf("unknown value kind")
		}
	}
	return nil
}
func appendPath(path []Value, v Value) []Value {
	next := make([]Value, len(path)+1)
	copy(next, path)
	next[len(path)] = v
	return next
}

type jsonReader struct {
	text    string
	at      int
	tagged  bool
	resolve func(string, string) (Value, error)
}

func Decode(b []byte, tagged bool, resolve func(string, string) (Value, error)) (Value, error) {
	if !utf8.Valid(b) {
		return Value{}, fmt.Errorf("invalid UTF-8 JSON")
	}
	r := jsonReader{text: string(b), tagged: tagged, resolve: resolve}
	v, e := r.value()
	if e != nil {
		return Value{}, e
	}
	r.space()
	if r.at != len(r.text) {
		return Value{}, r.error()
	}
	return v, nil
}
func (r *jsonReader) error() error { return fmt.Errorf("invalid JSON at byte %d", r.at) }
func (r *jsonReader) space() {
	for r.at < len(r.text) && strings.ContainsRune(" \t\r\n", rune(r.text[r.at])) {
		r.at++
	}
}
func (r *jsonReader) take(s string) bool {
	if strings.HasPrefix(r.text[r.at:], s) {
		r.at += len(s)
		return true
	}
	return false
}
func (r *jsonReader) value() (Value, error) {
	r.space()
	if r.at >= len(r.text) {
		return Value{}, r.error()
	}
	switch r.text[r.at] {
	case '"':
		s, e := r.string()
		if e != nil {
			return Value{}, e
		}
		return NewText(s)
	case '[':
		r.at++
		r.space()
		var items []Value
		if r.take("]") {
			return NewList(items), nil
		}
		for {
			v, e := r.value()
			if e != nil {
				return Value{}, e
			}
			items = append(items, v)
			r.space()
			if r.take("]") {
				return NewList(items), nil
			}
			if !r.take(",") {
				return Value{}, r.error()
			}
		}
	case '{':
		r.at++
		r.space()
		var pairs []Pair
		if r.take("}") {
			return NewMap(pairs)
		}
		for {
			r.space()
			key, e := r.string()
			if e != nil {
				return Value{}, e
			}
			r.space()
			if !r.take(":") {
				return Value{}, r.error()
			}
			v, e := r.value()
			if e != nil {
				return Value{}, e
			}
			pairs = append(pairs, Pair{key, v})
			r.space()
			if r.take("}") {
				break
			}
			if !r.take(",") {
				return Value{}, r.error()
			}
		}
		v, e := NewMap(pairs)
		if e != nil {
			return Value{}, e
		}
		if !r.tagged {
			return v, nil
		}
		hasTag := false
		for _, p := range v.Entries {
			if strings.HasPrefix(p.Key, "$") {
				hasTag = true
			}
		}
		if !hasTag {
			return v, nil
		}
		if len(v.Entries) != 1 {
			return Value{}, fmt.Errorf("tag object must have exactly one key")
		}
		return r.tag(v.Entries[0])
	case 'n':
		if r.take("null") {
			return Value{}, nil
		}
	case 't':
		if r.take("true") {
			return Value{Kind: Boolean, Bool: true}, nil
		}
	case 'f':
		if r.take("false") {
			return Value{Kind: Boolean}, nil
		}
	default:
		start := r.at
		for r.at < len(r.text) && strings.ContainsRune("0123456789eE.+-", rune(r.text[r.at])) {
			r.at++
		}
		n, e := decimal.ParseJSON(r.text[start:r.at])
		if e != nil {
			return Value{}, r.error()
		}
		return Value{Kind: Number, Number: n}, nil
	}
	return Value{}, r.error()
}
func (r *jsonReader) hex() (rune, error) {
	if r.at+4 > len(r.text) {
		return 0, r.error()
	}
	s := r.text[r.at : r.at+4]
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
			return 0, r.error()
		}
	}
	v, _ := strconv.ParseUint(s, 16, 16)
	r.at += 4
	return rune(v), nil
}
func (r *jsonReader) string() (string, error) {
	if !r.take(`"`) {
		return "", r.error()
	}
	var out strings.Builder
	for r.at < len(r.text) {
		cp, size := utf8.DecodeRuneInString(r.text[r.at:])
		r.at += size
		if cp == '"' {
			return out.String(), nil
		}
		if cp < 0x20 {
			return "", r.error()
		}
		if cp != '\\' {
			out.WriteRune(cp)
			continue
		}
		if r.at == len(r.text) {
			return "", r.error()
		}
		escape := r.text[r.at]
		r.at++
		switch escape {
		case '"', '\\', '/':
			out.WriteByte(escape)
		case 'b':
			out.WriteByte('\b')
		case 'f':
			out.WriteByte('\f')
		case 'n':
			out.WriteByte('\n')
		case 'r':
			out.WriteByte('\r')
		case 't':
			out.WriteByte('\t')
		case 'u':
			c, e := r.hex()
			if e != nil {
				return "", e
			}
			if c >= 0xd800 && c <= 0xdbff {
				if !r.take(`\u`) {
					return "", r.error()
				}
				low, e := r.hex()
				if e != nil || low < 0xdc00 || low > 0xdfff {
					return "", r.error()
				}
				c = 0x10000 + (c-0xd800)*0x400 + low - 0xdc00
			} else if c >= 0xdc00 && c <= 0xdfff {
				return "", r.error()
			}
			out.WriteRune(c)
		default:
			return "", r.error()
		}
	}
	return "", r.error()
}
func (r *jsonReader) tag(p Pair) (Value, error) {
	v := p.Val
	bad := func() (Value, error) { return Value{}, fmt.Errorf("invalid %s tag", p.Key) }
	switch p.Key {
	case "$dec":
		if v.Kind != Text {
			return bad()
		}
		n, e := decimal.Parse(v.Text)
		if e != nil {
			return Value{}, e
		}
		return Value{Kind: Number, Number: n}, nil
	case "$bytes":
		if v.Kind != Text {
			return bad()
		}
		b, e := base64.StdEncoding.Strict().DecodeString(v.Text)
		if e != nil || base64.StdEncoding.EncodeToString(b) != v.Text {
			return bad()
		}
		return NewBytes(b), nil
	case "$quantity":
		if v.Kind != List || len(v.Items) != 2 || v.Items[0].Kind != Text || v.Items[1].Kind != Text {
			return bad()
		}
		n, e := decimal.Parse(v.Items[0].Text)
		if e != nil {
			return Value{}, e
		}
		return NewQuantity(n, v.Items[1].Text)
	case "$range":
		if v.Kind != List || len(v.Items) != 2 {
			return bad()
		}
		return NewRange(v.Items[0], v.Items[1])
	case "$date":
		if v.Kind != Text {
			return bad()
		}
		return ParseCivil(v.Text)
	case "$instant":
		if v.Kind != Text {
			return bad()
		}
		return ParseInstant(v.Text)
	case "$map":
		if v.Kind != List {
			return bad()
		}
		pairs := make([]Pair, len(v.Items))
		for i, item := range v.Items {
			if item.Kind != List || len(item.Items) != 2 || item.Items[0].Kind != Text {
				return bad()
			}
			pairs[i] = Pair{item.Items[0].Text, item.Items[1]}
		}
		return NewMap(pairs)
	case "$object":
		if v.Kind != List || len(v.Items) != 2 || v.Items[0].Kind != Text || v.Items[1].Kind != Text || r.resolve == nil {
			return bad()
		}
		o, e := r.resolve(v.Items[0].Text, v.Items[1].Text)
		if e != nil {
			return Value{}, e
		}
		if o.Kind != Object || o.Object.Kind != v.Items[0].Text || o.Object.ID != v.Items[1].Text {
			return bad()
		}
		return o, nil
	case "$pattern":
		if v.Kind != Text {
			return bad()
		}
		return ParsePattern(v.Text)
	}
	return bad()
}
