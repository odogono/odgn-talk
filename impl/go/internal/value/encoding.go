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
	return EncodeWire(v, plain, nil)
}

// EncodeWire is the Value Encoding with Function Values written by
// function, as the Message Layer carries them; nil refuses them.
func EncodeWire(v Value, plain bool, function func(*FunctionData) (string, error)) ([]byte, error) {
	var out strings.Builder
	err := encode(&out, v, plain, function)
	if err != nil {
		return nil, err
	}
	return []byte(out.String()), nil
}

// Values and pending punctuation live on a heap work stack. Paths are linked
// during traversal and materialized only for an error, avoiding quadratic
// copying for a deeply nested encodable Value.
type encodingPath struct {
	parent *encodingPath
	key    Value
}
type encodingStep struct {
	value Value
	text  string
	path  *encodingPath
}

func encode(out *strings.Builder, root Value, plain bool, function func(*FunctionData) (string, error)) error {
	stack := []encodingStep{{value: root}}
	for len(stack) > 0 {
		step := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if step.text != "" {
			out.WriteString(step.text)
			continue
		}
		v := step.value
		push := func(v Value, key Value) {
			stack = append(stack, encodingStep{value: v, path: &encodingPath{step.path, key}})
		}
		text := func(s string) { stack = append(stack, encodingStep{text: s}) }
		switch v.Kind {
		case List:
			out.WriteByte('[')
			text("]")
			items := v.Items()
			for i := len(items) - 1; i >= 0; i-- {
				push(items[i], Fields{Kind: Number, Number: decimal.FromInt(int64(i + 1))}.Value())
				if i > 0 {
					text(",")
				}
			}
		case Map:
			wrapped := false
			for _, p := range v.Entries() {
				if !plain && strings.HasPrefix(p.Key, "$") {
					wrapped = true
					break
				}
			}
			if wrapped {
				out.WriteString(`{"$map":[`)
				text("]}")
			} else {
				out.WriteByte('{')
				text("}")
			}
			pairs := v.Entries()
			for i := len(pairs) - 1; i >= 0; i-- {
				p := pairs[i]
				if wrapped {
					text("]")
				}
				push(p.Val, Fields{Kind: Text, Text: p.Key}.Value())
				if wrapped {
					text(",")
				} else {
					text(":")
				}
				text(JSONString(p.Key, plain))
				if wrapped {
					text("[")
				}
				if i > 0 {
					text(",")
				}
			}
		case Range:
			if plain {
				return encodingFailure(v.Kind, step.path)
			}
			out.WriteString(`{"$range":[`)
			text("]}")
			stack = append(stack, encodingStep{value: v.Items()[1], path: step.path})
			text(",")
			stack = append(stack, encodingStep{value: v.Items()[0], path: step.path})
		case Function:
			if function == nil || plain {
				return encodingFailure(v.Kind, step.path)
			}
			s, err := function(v.Function())
			if err != nil {
				return err
			}
			out.WriteString(s)
		default:
			if plain && v.Kind != Nothing && v.Kind != Boolean && v.Kind != Number && v.Kind != Text {
				return encodingFailure(v.Kind, step.path)
			}
			if err := encodeLeaf(out, v, plain); err != nil {
				return err
			}
		}
	}
	return nil
}
func encodingFailure(kind Kind, path *encodingPath) error {
	var keys []Value
	for p := path; p != nil; p = p.parent {
		keys = append(keys, p.key)
	}
	for i, j := 0, len(keys)-1; i < j; i, j = i+1, j-1 {
		keys[i], keys[j] = keys[j], keys[i]
	}
	return &EncodingError{kind, keys}
}
func encodeLeaf(out *strings.Builder, v Value, plain bool) error {
	str := func(s string) { out.WriteString(JSONString(s, plain)) }
	tag := func(name, s string) { out.WriteString(`{"` + name + `":`); str(s); out.WriteByte('}') }
	switch v.Kind {
	case Nothing:
		out.WriteString("null")
	case Boolean:
		out.WriteString(strconv.FormatBool(v.Bool))
	case Number:
		n := v.Number().String()
		if plain || jsonNumber(v.Number()) {
			out.WriteString(n)
		} else {
			tag("$dec", n)
		}
	case Text:
		str(v.Text())
	case Bytes:
		tag("$bytes", base64.StdEncoding.EncodeToString(v.Bytes()))
	case Quantity:
		out.WriteString(`{"$quantity":[`)
		str(v.Number().String())
		out.WriteByte(',')
		str(v.Unit().String())
		out.WriteString("]}")
	case Instant:
		tag("$instant", v.Display())
	case CivilDate:
		tag("$date", v.Display())
	case Pattern:
		tag("$pattern", v.Text())
	case Object:
		out.WriteString(`{"$object":[`)
		str(v.Object().Kind)
		out.WriteByte(',')
		str(v.Object().ID)
		out.WriteString("]}")
	default:
		return fmt.Errorf("unknown value kind")
	}
	return nil
}

// jsonNumber is the Value Encoding's untagged number form: no fraction
// digits and a magnitude strictly below 2^53.
func jsonNumber(n decimal.Number) bool {
	integer, err := n.Int64()
	return n.Exponent() == 0 && err == nil && integer > -9007199254740992 && integer < 9007199254740992
}

type jsonReader struct {
	text         string
	at           int
	tagged       bool
	members      bool
	coreMessages bool
	resolve      func(string, string) (Value, error)
	function     func(string) (Value, error)
	wire         func(Value) (Value, error)
}

func Decode(b []byte, tagged bool, resolve func(string, string) (Value, error)) (Value, error) {
	return DecodeWithFunctions(b, tagged, resolve, nil)
}
func DecodeWithFunctions(b []byte, tagged bool, resolve func(string, string) (Value, error), function func(string) (Value, error)) (Value, error) {
	return decodeWith(jsonReader{tagged: tagged, resolve: resolve, function: function}, b)
}

// DecodeWire also accepts the Message Layer's {"$function": [home, display,
// token]}, which wire turns into a Function Value from the payload list,
// and core-message-v1's provenance wrapper around a map.
func DecodeWire(b []byte, resolve func(string, string) (Value, error), wire func(Value) (Value, error)) (Value, error) {
	return decodeWith(jsonReader{tagged: true, resolve: resolve, wire: wire, coreMessages: true}, b)
}
func decodeWith(r jsonReader, b []byte) (Value, error) {
	if !utf8.Valid(b) {
		return Value{}, fmt.Errorf("invalid UTF-8 JSON")
	}
	r.text = string(b)
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

// DecodeMembers decodes one Store contents object. Only its outer keys are
// literal; nested members still use the Value Encoding's tags.
func DecodeMembers(b []byte) ([]Pair, error) {
	if !utf8.Valid(b) {
		return nil, fmt.Errorf("invalid UTF-8 JSON")
	}
	r := jsonReader{text: string(b), tagged: true, members: true}
	v, err := r.value()
	if err != nil {
		return nil, err
	}
	r.space()
	if r.at != len(r.text) || v.Kind != Map {
		return nil, fmt.Errorf("Expected one JSON object")
	}
	return v.Entries(), nil
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

type jsonContainer struct {
	object bool
	items  []Value
	pairs  []Pair
	key    string
}

func (r *jsonReader) value() (Value, error) {
	var stack []jsonContainer
	var v Value
	for {
		r.space()
		if r.at >= len(r.text) {
			return Value{}, r.error()
		}
		c := r.text[r.at]
		if c == '[' || c == '{' {
			r.at++
			r.space()
			closing := "]"
			if c == '{' {
				closing = "}"
			}
			if r.take(closing) {
				if c == '{' {
					var err error
					v, err = NewMap(nil)
					if err != nil {
						return Value{}, err
					}
				} else {
					v = NewList(nil)
				}
			} else {
				b := jsonContainer{object: c == '{'}
				if b.object {
					var err error
					b.key, err = r.key()
					if err != nil {
						return Value{}, err
					}
				}
				stack = append(stack, b)
				continue
			}
		} else {
			var err error
			v, err = r.leaf()
			if err != nil {
				return Value{}, err
			}
		}
		for {
			if len(stack) == 0 {
				return v, nil
			}
			b := &stack[len(stack)-1]
			if b.object {
				b.pairs = append(b.pairs, Pair{b.key, v})
			} else {
				b.items = append(b.items, v)
			}
			r.space()
			closing := "]"
			if b.object {
				closing = "}"
			}
			if r.take(closing) {
				var err error
				if b.object {
					v, err = NewMap(b.pairs)
					if err == nil && r.tagged && !(r.members && len(stack) == 1) {
						tagged := false
						for _, p := range v.Entries() {
							tagged = tagged || strings.HasPrefix(p.Key, "$")
						}
						if tagged {
							if len(v.Entries()) != 1 {
								return Value{}, fmt.Errorf("tag object must have exactly one key")
							}
							v, err = r.tag(v.Entries()[0])
						}
					}
				} else {
					v = NewList(b.items)
				}
				if err != nil {
					return Value{}, err
				}
				stack = stack[:len(stack)-1]
				continue
			}
			if !r.take(",") {
				return Value{}, r.error()
			}
			if b.object {
				var err error
				b.key, err = r.key()
				if err != nil {
					return Value{}, err
				}
			}
			break
		}
	}
}
func (r *jsonReader) key() (string, error) {
	r.space()
	key, err := r.string()
	if err != nil {
		return "", err
	}
	r.space()
	if !r.take(":") {
		return "", r.error()
	}
	return key, nil
}
func (r *jsonReader) leaf() (Value, error) {
	switch r.text[r.at] {
	case '"':
		s, err := r.string()
		if err != nil {
			return Value{}, err
		}
		return NewText(s)
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
		text := r.text[start:r.at]
		n, e := decimal.ParseJSON(text)
		if e != nil {
			return Value{}, r.error()
		}
		if r.tagged && (n.String() != text || !jsonNumber(n)) {
			return Value{}, fmt.Errorf("noncanonical Value Encoding number")
		}
		return Fields{Kind: Number, Number: n}.Value(), nil
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
	case "$coreMessage":
		if !r.coreMessages || v.Kind != Map {
			return bad()
		}
		v.CoreMessage = true
		return v, nil
	case "$function":
		if v.Kind != List || r.wire == nil {
			return bad()
		}
		return r.wire(v)
	case "$sessionFunction":
		if v.Kind != Text || r.function == nil {
			return bad()
		}
		return r.function(v.Text())
	case "$dec":
		if v.Kind != Text {
			return bad()
		}
		n, e := decimal.Parse(v.Text())
		if e != nil {
			return Value{}, e
		}
		if n.String() != v.Text() || jsonNumber(n) {
			return bad()
		}
		return Fields{Kind: Number, Number: n}.Value(), nil
	case "$bytes":
		if v.Kind != Text {
			return bad()
		}
		b, e := base64.StdEncoding.Strict().DecodeString(v.Text())
		if e != nil || base64.StdEncoding.EncodeToString(b) != v.Text() {
			return bad()
		}
		return NewBytes(b), nil
	case "$quantity":
		if v.Kind != List || len(v.Items()) != 2 || v.Items()[0].Kind != Text || v.Items()[1].Kind != Text {
			return bad()
		}
		n, e := decimal.Parse(v.Items()[0].Text())
		if e != nil {
			return Value{}, e
		}
		q, e := NewQuantity(n, v.Items()[1].Text())
		if e != nil {
			return Value{}, e
		}
		if q.Kind != Quantity || n.String() != v.Items()[0].Text() || q.Unit().String() != v.Items()[1].Text() {
			return bad()
		}
		return q, nil
	case "$range":
		if v.Kind != List || len(v.Items()) != 2 {
			return bad()
		}
		return NewRange(v.Items()[0], v.Items()[1])
	case "$date":
		if v.Kind != Text {
			return bad()
		}
		d, e := ParseCivil(v.Text())
		if e != nil {
			return Value{}, e
		}
		if d.Display() != v.Text() {
			return bad()
		}
		return d, nil
	case "$instant":
		if v.Kind != Text {
			return bad()
		}
		i, e := ParseInstant(v.Text())
		if e != nil {
			return Value{}, e
		}
		if i.Display() != v.Text() {
			return bad()
		}
		return i, nil
	case "$map":
		if v.Kind != List {
			return bad()
		}
		pairs := make([]Pair, len(v.Items()))
		hasDollarKey := false
		for i, item := range v.Items() {
			if item.Kind != List || len(item.Items()) != 2 || item.Items()[0].Kind != Text {
				return bad()
			}
			pairs[i] = Pair{item.Items()[0].Text(), item.Items()[1]}
			hasDollarKey = hasDollarKey || strings.HasPrefix(pairs[i].Key, "$")
		}
		if !hasDollarKey {
			return bad()
		}
		return NewMap(pairs)
	case "$object":
		if v.Kind != List || len(v.Items()) != 2 || v.Items()[0].Kind != Text || v.Items()[1].Kind != Text || r.resolve == nil {
			return bad()
		}
		o, e := r.resolve(v.Items()[0].Text(), v.Items()[1].Text())
		if e != nil {
			return Value{}, e
		}
		if o.Kind != Object || o.Object().Kind != v.Items()[0].Text() || o.Object().ID != v.Items()[1].Text() {
			return bad()
		}
		return o, nil
	case "$pattern":
		if v.Kind != Text {
			return bad()
		}
		pattern, e := ParsePattern(v.Text())
		if e != nil {
			return Value{}, e
		}
		if pattern.Text() != v.Text() {
			return bad()
		}
		return pattern, nil
	}
	return bad()
}
