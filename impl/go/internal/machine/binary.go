package machine

import (
	"github.com/odogono/odgn-talk/impl/go/internal/decimal"
	"github.com/odogono/odgn-talk/impl/go/internal/generated"
	"github.com/odogono/odgn-talk/impl/go/internal/lower"
	"github.com/odogono/odgn-talk/impl/go/internal/value"
	"math/big"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"
)

func binaryInteger(v value.Value, bits int, signed bool, field string) (*big.Int, *value.Value) {
	if v.Kind != value.Number {
		e := wrong("number", v)
		return nil, &e
	}
	n, ok := v.Number().Integer()
	if !ok {
		e := wrong("integer", v)
		return nil, &e
	}
	width := bits
	if signed {
		width--
	}
	// Every Number is below 10^34, so widths beyond 113 cannot reject a
	// positive Number and need no enormous power-of-two temporary.
	if width > 113 {
		if signed || n.Sign() >= 0 {
			return n, nil
		}
		e := failure("out of range", value.Pair{Key: "field", Val: text(field)}, value.Pair{Key: "value", Val: v})
		return nil, &e
	}
	limit := new(big.Int).Lsh(big.NewInt(1), uint(width))
	lo := new(big.Int)
	if signed {
		lo.Neg(limit)
	}
	if n.Cmp(lo) < 0 || n.Cmp(limit) >= 0 {
		e := failure("out of range", value.Pair{Key: "field", Val: text(field)}, value.Pair{Key: "value", Val: v})
		return nil, &e
	}
	return n, nil
}
func fieldType(field string) (bits int, signed, little bool) {
	kind := strings.Fields(field)[0]
	signed = strings.HasPrefix(kind, "int")
	digits := strings.TrimPrefix(strings.TrimPrefix(kind, "uint"), "int")
	bits, _ = strconv.Atoi(digits)
	little = strings.Contains(field, "little")
	return
}
func fieldBytes(v value.Value, field string, size *value.Value) ([]byte, *value.Value) {
	if size != nil {
		expected := "bytes"
		if strings.Contains(field, "text") {
			expected = "text"
		}
		if !kindTest(v, expected) {
			e := wrong(expected, v)
			return nil, &e
		}
		var bytes []byte
		if v.Kind == value.Text {
			bytes = []byte(v.Text())
		} else {
			bytes = v.Bytes()
		}
		n, e := binaryInteger(*size, 112, false, "bytes")
		if e != nil {
			return nil, e
		}
		if n.Cmp(big.NewInt(int64(len(bytes)))) != 0 {
			e := failure("out of range", value.Pair{Key: "field", Val: text(field)}, value.Pair{Key: "value", Val: v})
			return nil, &e
		}
		return slices.Clone(bytes), nil
	}
	if field == "" || field == "value" {
		switch v.Kind {
		case value.Text:
			return []byte(v.Text()), nil
		case value.Bytes:
			return slices.Clone(v.Bytes()), nil
		case value.Number:
			field = "byte"
		default:
			e := wrong("bytes", v)
			return nil, &e
		}
	}
	bits, signed, little := 8, false, false
	if field != "byte" {
		bits, signed, little = fieldType(field)
	}
	n, e := binaryInteger(v, bits, signed, field)
	if e != nil {
		return nil, e
	}
	if n.Sign() < 0 {
		n.Add(n, new(big.Int).Lsh(big.NewInt(1), uint(bits)))
	}
	out := make([]byte, bits/8)
	n.FillBytes(out)
	if little {
		slices.Reverse(out)
	}
	return out, nil
}
func binaryInstruction(f *Frame, t *frameTrial, i lower.Instruction, s *State, m *Measures) *value.Value {
	args := i.Operands()
	pop := func() value.Value { v := f.Stack[len(f.Stack)-1]; t.shrink(f, len(f.Stack)-1); return v }
	push := func(v value.Value) { f.Stack = append(f.Stack, v) }
	result := func(v value.Value) { push(v); m.Result = v; m.ResultPresent = true }
	jump := func() { f.PC = args[len(args)-1].Index - 1 }
	if i.Op == generated.OpBytesField || i.Op == generated.OpBytesSized || i.Op == generated.OpBytesBits {
		var whole value.Value
		var bytes []byte
		if i.Op == generated.OpBytesBits {
			n := args[1].Index
			vs := slices.Clone(f.Stack[len(f.Stack)-n:])
			t.shrink(f, len(f.Stack)-n)
			whole = pop()
			widths := s.Constants[args[0].Index].Items()
			number := new(big.Int)
			total := 0
			for j, v := range vs {
				width, _ := widths[j].Number().Int64()
				x, e := binaryInteger(v, int(width), false, strconv.FormatInt(width, 10)+" bits")
				if e != nil {
					return e
				}
				number.Lsh(number, uint(width))
				number.Or(number, x)
				total += int(width)
			}
			bytes = make([]byte, total/8)
			number.FillBytes(bytes)
		} else {
			var size *value.Value
			if i.Op == generated.OpBytesSized {
				n := pop()
				size = &n
			}
			v := pop()
			whole = pop()
			m.Input = v
			m.InputPresent = true
			var e *value.Value
			bytes, e = fieldBytes(v, args[0].Text, size)
			if e != nil {
				return e
			}
		}
		result(value.NewBytes(append(slices.Clone(whole.Bytes()), bytes...)))
		return nil
	}
	if i.Op == generated.OpBinStart {
		v := pop()
		if v.Kind != value.Bytes {
			jump()
		} else {
			push(value.Fields{Kind: value.BinaryReader, Reader: &value.ReaderData{Snapshot: v}}.Value())
		}
		return nil
	}
	var size value.Value
	if i.Op == generated.OpBinBytes {
		size = pop()
	}
	v := pop()
	reader := *v.Reader()
	remaining := reader.Snapshot.Bytes()[reader.Position:]
	take := func(n int) []byte {
		if n < 0 || n > len(remaining) {
			return nil
		}
		bytes := remaining[:n]
		reader.Position += n
		return bytes
	}
	finish := func(bytes []byte, asText bool) (value.Value, bool) {
		if asText {
			if !utf8.Valid(bytes) {
				return value.Value{}, false
			}
			return text(string(bytes)), true
		}
		return value.NewBytes(bytes), true
	}
	switch i.Op {
	case generated.OpBinEnd:
		if len(remaining) != 0 {
			jump()
		}
	case generated.OpBinLiteral:
		expected, e := fieldBytes(s.Constants[args[0].Index], "", nil)
		if e != nil || len(remaining) < len(expected) || !slices.Equal(remaining[:len(expected)], expected) {
			jump()
			break
		}
		reader.Position += len(expected)
		push(value.Fields{Kind: value.BinaryReader, Reader: &reader}.Value())
	case generated.OpBinInt:
		bits, signed, little := fieldType(args[0].Text)
		bytes := take(bits / 8)
		if bytes == nil {
			jump()
			break
		}
		bytes = slices.Clone(bytes)
		if little {
			slices.Reverse(bytes)
		}
		number := new(big.Int).SetBytes(bytes)
		if signed && number.Bit(bits-1) != 0 {
			number.Sub(number, new(big.Int).Lsh(big.NewInt(1), uint(bits)))
		}
		n, _ := decimal.Round(new(big.Rat).SetInt(number), 0, "binary")
		push(value.Fields{Kind: value.BinaryReader, Reader: &reader}.Value())
		result(value.Fields{Kind: value.Number, Number: n}.Value())
	case generated.OpBinBits:
		widths := s.Constants[args[0].Index].Items()
		bits := new(big.Int)
		for _, w := range widths {
			n, _ := w.Number().Integer()
			bits.Add(bits, n)
		}
		available := new(big.Int).Mul(big.NewInt(int64(len(reader.Snapshot.Bytes())-reader.Position)), big.NewInt(8))
		if bits.Cmp(available) > 0 {
			jump()
			break
		}
		total := int(bits.Int64())
		bytes := take(total / 8)
		if bytes == nil {
			jump()
			break
		}
		number := new(big.Int).SetBytes(bytes)
		push(value.Fields{Kind: value.BinaryReader, Reader: &reader}.Value())
		m.ResultValues = []value.Value{}
		for _, w := range widths {
			width, _ := w.Number().Int64()
			total -= int(width)
			n := new(big.Int).Rsh(new(big.Int).Set(number), uint(total))
			mask := new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), uint(width)), big.NewInt(1))
			n.And(n, mask)
			dec, _ := decimal.Round(new(big.Rat).SetInt(n), 0, "binary")
			x := value.Fields{Kind: value.Number, Number: dec}.Value()
			result(x)
			m.ResultValues = append(m.ResultValues, x)
		}
	case generated.OpBinBytes:
		if size.Kind != value.Number {
			jump()
			break
		}
		n, e := size.Number().Int64()
		if e != nil || n < 0 || n > int64(len(remaining)) {
			jump()
			break
		}
		bytes := take(int(n))
		x, ok := finish(bytes, strings.Contains(args[0].Text, "text"))
		if !ok {
			jump()
			break
		}
		push(value.Fields{Kind: value.BinaryReader, Reader: &reader}.Value())
		result(x)
	case generated.OpBinRest:
		x, ok := finish(remaining, strings.Contains(args[0].Text, "text"))
		if !ok {
			jump()
		} else {
			result(x)
		}
	}
	return nil
}
