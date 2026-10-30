package value

import (
	"encoding/binary"
	"fmt"
	"math"
	"strconv"
	"strings"

	"northtalk.org/go/internal/decimal"
)

// BinaryOptions supplies transport-owned Function identity without coupling
// the Value codec to a reactor, snapshot, or JSON representation.
type BinaryOptions struct {
	CoreErrors       bool
	FunctionMetadata bool
	Encode           func(*FunctionData) ([]Value, error)
	Decode           func([]Value) (Value, error)
}

// AppendBinary writes a canonical Value item. Containers use a heap work stack;
// no Go recursion or protocol nesting limit is involved. The Function payload
// is the negotiated 3-, 6-, or 7-item metadata form.
func AppendBinary(dst []byte, root Value, functions BinaryOptions) ([]byte, error) {
	stack := []Value{root}
	text := func(s string) { dst = binary.AppendUvarint(dst, uint64(len(s))); dst = append(dst, s...) }
	push := func(xs []Value) {
		for i := len(xs) - 1; i >= 0; i-- {
			stack = append(stack, xs[i])
		}
	}
	for len(stack) != 0 {
		v := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		switch v.Kind {
		case Nothing:
			dst = append(dst, 0)
		case Boolean:
			if v.Bool {
				dst = append(dst, 2)
			} else {
				dst = append(dst, 1)
			}
		case Number:
			if i, ok := v.Number().SmallInteger(); ok {
				if i >= 0 {
					dst = binary.AppendUvarint(append(dst, 3), uint64(i))
				} else {
					dst = binary.AppendUvarint(append(dst, 16), uint64(-(i+1))+1)
				}
				continue
			}
			s := v.Number().String()
			if v.Number().Exponent() == 0 {
				if n, err := strconv.ParseUint(s, 10, 64); err == nil {
					dst = binary.AppendUvarint(append(dst, 3), n)
					continue
				}
				if strings.HasPrefix(s, "-") {
					if n, err := strconv.ParseUint(s[1:], 10, 64); err == nil {
						dst = binary.AppendUvarint(append(dst, 16), n)
						continue
					}
					if s == "-18446744073709551616" {
						dst = append(dst, 16, 128, 128, 128, 128, 128, 128, 128, 128, 128, 2)
						continue
					}
				}
			}
			dst = append(dst, 4)
			text(s)
		case Text:
			dst = append(dst, 5)
			text(v.Text())
		case List:
			dst = binary.AppendUvarint(append(dst, 6), uint64(len(v.Items())))
			push(v.Items())
		case Map:
			tag := byte(7)
			if v.CoreMessage && functions.CoreErrors {
				tag = 17
			}
			pairs := v.Entries()
			dst = binary.AppendUvarint(append(dst, tag), uint64(len(pairs)))
			for i := len(pairs) - 1; i >= 0; i-- {
				stack = append(stack, pairs[i].Val, Fields{Kind: Text, Text: pairs[i].Key}.Value())
			}
		case Bytes:
			dst = binary.AppendUvarint(append(dst, 8), uint64(len(v.Bytes())))
			dst = append(dst, v.Bytes()...)
		case Quantity:
			dst = append(dst, 9)
			stack = append(stack, Fields{Kind: Text, Text: v.Unit().String()}.Value(), Fields{Kind: Number, Number: v.Number()}.Value())
		case Range:
			dst = append(dst, 10)
			push(v.Items())
		case Instant:
			n := v.Seconds()*1000000 + int64(v.Micros())
			dst = binary.AppendUvarint(append(dst, 11), uint64(n<<1)^uint64(n>>63))
		case CivilDate:
			dst = append(dst, 12)
			text(v.Display())
		case Pattern:
			dst = append(dst, 13)
			text(v.Text())
		case Object:
			if v.Object() == nil {
				return nil, fmt.Errorf("invalid Object")
			}
			dst = append(dst, 14)
			push([]Value{Fields{Kind: Text, Text: v.Object().Kind}.Value(), Fields{Kind: Text, Text: v.Object().ID}.Value()})
		case Function:
			if functions.Encode == nil {
				return nil, fmt.Errorf("Function encoder required")
			}
			xs, err := functions.Encode(v.Function())
			if err != nil {
				return nil, err
			}
			if !binaryFunctionValid(xs) || len(xs) > 3 && !functions.FunctionMetadata {
				return nil, fmt.Errorf("invalid Function payload")
			}
			if len(xs) == 3 {
				dst = append(dst, 15)
			} else {
				dst = binary.AppendUvarint(append(dst, 19), uint64(len(xs)))
			}
			push(xs)
		default:
			return nil, fmt.Errorf("not encodable: %s", KindNames[v.Kind])
		}
	}
	return dst, nil
}

type binaryValueReader struct {
	data []byte
	at   int
}

func (r *binaryValueReader) uint() (uint64, error) {
	n, used := binary.Uvarint(r.data[r.at:])
	if used <= 0 || used > 1 && r.data[r.at+used-1] == 0 {
		return 0, fmt.Errorf("invalid binary integer at %d", r.at)
	}
	r.at += used
	return n, nil
}
func (r *binaryValueReader) bytes() ([]byte, error) {
	n, err := r.uint()
	if err != nil || n > uint64(len(r.data)-r.at) {
		return nil, fmt.Errorf("invalid binary length at %d", r.at)
	}
	b := r.data[r.at : r.at+int(n)]
	r.at += int(n)
	return b, nil
}
func (r *binaryValueReader) text() (string, error) {
	b, err := r.bytes()
	if err != nil {
		return "", err
	}
	s := string(b)
	v, err := NewText(s)
	if err != nil || v.Text() != s {
		return "", fmt.Errorf("noncanonical binary text")
	}
	return s, nil
}

// DecodeBinary reads exactly one Value. Object and Function resolution use the
// same owner-specific identities as the Message Layer; they are never snapshots.
func DecodeBinary(data []byte, resolve func(string, string) (Value, error), functions BinaryOptions) (Value, error) {
	r := binaryValueReader{data: data}
	type container struct {
		tag    byte
		count  int
		values []Value
	}
	var stack []container
	invalid := func() (Value, error) { return Value{}, fmt.Errorf("invalid binary Value at %d", r.at) }
	finish := func(c container) (Value, error) {
		x := c.values
		switch c.tag {
		case 6:
			return Fields{Kind: List, Items: x}.Value(), nil
		case 7, 17:
			if c.tag == 17 && !functions.CoreErrors {
				return invalid()
			}
			pairs := make([]Pair, len(x)/2)
			seen := make(map[string]bool, len(pairs))
			for i := range pairs {
				k := x[2*i]
				if k.Kind != Text || seen[k.Text()] {
					return invalid()
				}
				seen[k.Text()] = true
				pairs[i] = Pair{k.Text(), x[2*i+1]}
			}
			if c.tag == 17 {
				valid := false
				for _, p := range pairs {
					valid = valid || p.Key == "message" && p.Val.Kind == Text
				}
				if !valid {
					return invalid()
				}
			}
			return Fields{Kind: Map, Entries: pairs, CoreMessage: c.tag == 17}.Value(), nil
		case 9:
			if x[0].Kind != Number || x[1].Kind != Text {
				return invalid()
			}
			u, err := ParseUnit(x[1].Text())
			if err != nil || u.String() != x[1].Text() {
				return invalid()
			}
			return Fields{Kind: Quantity, Number: x[0].Number(), Unit: u}.Value(), nil
		case 10:
			return NewRange(x[0], x[1])
		case 14:
			if x[0].Kind != Text || x[1].Kind != Text || resolve == nil {
				return invalid()
			}
			return resolve(x[0].Text(), x[1].Text())
		case 15, 19:
			if functions.Decode == nil || !binaryFunctionValid(x) {
				return invalid()
			}
			return functions.Decode(x)
		}
		return invalid()
	}
	for {
		if r.at >= len(data) {
			return invalid()
		}
		tag := data[r.at]
		r.at++
		var v Value
		var err error
		count := -1
		switch tag {
		case 0:
		case 1, 2:
			v = Value{Kind: Boolean, Bool: tag == 2}
		case 3, 16:
			var s string
			// The negative magnitude 2^64 has a canonical 65-bit LEB128.
			if tag == 16 && len(data)-r.at >= 10 && string(data[r.at:r.at+10]) == string([]byte{128, 128, 128, 128, 128, 128, 128, 128, 128, 2}) {
				s = "-18446744073709551616"
				r.at += 10
			} else {
				n, e := r.uint()
				if e != nil || tag == 16 && n == 0 {
					return invalid()
				}
				if n <= math.MaxInt64 {
					i := int64(n)
					if tag == 16 {
						i = -i
					}
					v = Fields{Kind: Number, Number: decimal.FromInt(i)}.Value()
					break
				}
				s = strconv.FormatUint(n, 10)
				if tag == 16 {
					s = "-" + s
				}
			}
			n, e := decimal.Parse(s)
			if e != nil {
				return invalid()
			}
			v = Fields{Kind: Number, Number: n}.Value()
		case 4:
			s, e := r.text()
			if e != nil {
				return invalid()
			}
			n, e := decimal.Parse(s)
			if e != nil || n.String() != s {
				return invalid()
			}
			if n.Exponent() == 0 {
				if _, e := strconv.ParseUint(s, 10, 64); e == nil {
					return invalid()
				}
				if strings.HasPrefix(s, "-") {
					if _, e := strconv.ParseUint(s[1:], 10, 64); e == nil || s == "-18446744073709551616" {
						return invalid()
					}
				}
			}
			v = Fields{Kind: Number, Number: n}.Value()
		case 5:
			var s string
			s, err = r.text()
			v = Fields{Kind: Text, Text: s}.Value()
		case 6, 7, 17, 19:
			n, e := r.uint()
			if e != nil || n > uint64(len(data)-r.at) {
				return invalid()
			}
			if tag == 19 && (!functions.FunctionMetadata || n != 6 && n != 7) {
				return invalid()
			}
			if tag == 7 || tag == 17 {
				if n > uint64(len(data)-r.at)/2 {
					return invalid()
				}
				n *= 2
			}
			count = int(n)
		case 8:
			var b []byte
			b, err = r.bytes()
			v = NewBytes(b)
		case 9, 10, 14:
			count = 2
		case 15:
			count = 3
		case 11:
			u, e := r.uint()
			if e != nil {
				return invalid()
			}
			n := int64(u>>1) ^ -int64(u&1)
			seconds, micros := n/1000000, n%1000000
			if micros < 0 {
				seconds--
				micros += 1000000
			}
			v, err = NewInstant(seconds, int32(micros))
		case 12, 13:
			s, e := r.text()
			if e != nil {
				return invalid()
			}
			if tag == 12 {
				v, err = ParseCivil(s)
				if err == nil && v.Display() != s {
					return invalid()
				}
			} else {
				v, err = ParsePattern(s)
				if err == nil && v.Text() != s {
					return invalid()
				}
			}
		default:
			return invalid()
		}
		if err != nil {
			return Value{}, err
		}
		if count >= 0 {
			c := container{tag: tag, count: count, values: make([]Value, 0, count)}
			if count != 0 {
				stack = append(stack, c)
				continue
			}
			v, err = finish(c)
			if err != nil {
				return Value{}, err
			}
		}
		for {
			if len(stack) == 0 {
				if r.at != len(data) {
					return invalid()
				}
				return v, nil
			}
			c := &stack[len(stack)-1]
			c.values = append(c.values, v)
			if len(c.values) < c.count {
				break
			}
			v, err = finish(*c)
			if err != nil {
				return Value{}, err
			}
			stack = stack[:len(stack)-1]
		}
	}
}

func binaryFunctionValid(xs []Value) bool {
	if len(xs) != 3 && len(xs) != 6 && len(xs) != 7 {
		return false
	}
	for _, v := range xs[:3] {
		if v.Kind != Text {
			return false
		}
	}
	if len(xs) >= 6 {
		if xs[3].Kind != Nothing && xs[3].Kind != Text {
			return false
		}
		if xs[4].Kind != Number || xs[5].Kind != Number || xs[4].Number().Exponent() != 0 || xs[5].Number().Exponent() != 0 {
			return false
		}
		required, e1 := strconv.ParseUint(xs[4].Number().String(), 10, 64)
		total, e2 := strconv.ParseUint(xs[5].Number().String(), 10, 64)
		if e1 != nil || e2 != nil || required > total {
			return false
		}
	}
	return len(xs) != 7 || xs[6].Kind == Bytes && len(xs[6].Bytes()) == 32
}
