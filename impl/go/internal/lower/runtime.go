package lower

import "strconv"

// Operand is a detached view of a compiled operand. Labels use body-relative
// instruction indices, as in Bytecode; the machine never parses disassembly.
type Operand struct {
	Kind, Text string
	Index      int
}

func (i Instruction) Operands() []Operand {
	out := make([]Operand, len(i.args))
	for n, a := range i.args {
		out[n] = Operand{a.kind, a.text, a.index}
		if a.target != nil {
			out[n] = Operand{Kind: "label", Index: a.target.pc}
		} else if a.kind == "" {
			out[n].Index, _ = strconv.Atoi(a.text)
		}
	}
	return out
}

type UnwindEntry struct {
	First, Last   int
	Kind          string
	Target, Depth int
}

func (b *Body) UnwindEntries() []UnwindEntry {
	out := make([]UnwindEntry, len(b.Unwind))
	for i, u := range b.Unwind {
		out[i] = UnwindEntry{u.first, u.last, u.kind, u.target.pc, u.depth}
	}
	return out
}
