package lower

import (
	"encoding/binary"
	"errors"
	"github.com/odogono/odgn-talk/impl/go/internal/generated"
	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
)

// Bytecode is a Go-private encoding, not a Corpus or persistence format. It
// uses a version byte, a instruction count and unsigned varints: opcode-table
// index, source line/column, operand count, then tagged operands. A label is a
// body-relative instruction index; source positions never become byte offsets.
func (b *Body) Bytecode() []byte {
	out := binary.AppendUvarint([]byte{1}, uint64(len(b.Code)))
	appendText := func(s string) { out = binary.AppendUvarint(out, uint64(len(s))); out = append(out, s...) }
	for _, instruction := range b.Code {
		for _, value := range []int{int(instruction.Op), instruction.Pos.Line, instruction.Pos.Column, len(instruction.args)} {
			out = binary.AppendUvarint(out, uint64(value))
		}
		for _, arg := range instruction.args {
			switch {
			case arg.target != nil:
				out = append(out, 2)
				out = binary.AppendUvarint(out, uint64(arg.target.pc))
			case arg.kind != "":
				out = append(out, 1)
				appendText(arg.kind)
				out = binary.AppendUvarint(out, uint64(arg.index))
			default:
				out = append(out, 0)
				appendText(arg.text)
			}
		}
	}
	return out
}

func decodeBytecode(data []byte) ([]Instruction, error) {
	invalid := errors.New("invalid Go bytecode")
	if len(data) == 0 || data[0] != 1 {
		return nil, invalid
	}
	data = data[1:]
	read := func() (int, bool) {
		value, n := binary.Uvarint(data)
		if n <= 0 || value > uint64(int(^uint(0)>>1)) {
			return 0, false
		}
		data = data[n:]
		return int(value), true
	}
	readText := func() (string, bool) {
		length, ok := read()
		if !ok || length > len(data) {
			return "", false
		}
		s := string(data[:length])
		data = data[length:]
		return s, true
	}
	count, ok := read()
	if !ok || count > len(data)/4 {
		return nil, invalid
	}
	code := make([]Instruction, 0, count)
	for range count {
		opcode, ok := read()
		if !ok || opcode >= len(generated.Machine.Instruction) {
			return nil, invalid
		}
		line, ok := read()
		if !ok || line == 0 {
			return nil, invalid
		}
		column, ok := read()
		if !ok || column == 0 {
			return nil, invalid
		}
		argc, ok := read()
		if !ok || argc > len(data) {
			return nil, invalid
		}
		instruction := Instruction{Name: generated.Machine.Instruction[opcode].Name, Op: generated.Opcode(opcode), Pos: syntax.Position{Line: line, Column: column}}
		for range argc {
			if len(data) == 0 {
				return nil, invalid
			}
			tag := data[0]
			data = data[1:]
			var arg operand
			switch tag {
			case 0:
				arg.text, ok = readText()
			case 1:
				arg.kind, ok = readText()
				if !ok {
					return nil, invalid
				}
				arg.index, ok = read()
			case 2:
				var pc int
				pc, ok = read()
				if pc > count {
					return nil, invalid
				}
				arg = target(&label{pc: pc})
			default:
				return nil, invalid
			}
			if !ok {
				return nil, invalid
			}
			instruction.args = append(instruction.args, arg)
		}
		instruction.prepare()
		code = append(code, instruction)
	}
	if len(data) != 0 {
		return nil, invalid
	}
	return code, nil
}
