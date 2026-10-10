package lower

import (
	"strconv"

	"github.com/odogono/odgn-talk/impl/go/internal/generated"
)

// Operand is a read-only view of a compiled operand. Labels use body-relative
// instruction indices, as in Bytecode; the machine never parses disassembly.
type Operand struct {
	Kind, Text string
	Index      int
}

// Operands returns a read-only slice shared by copies of the instruction.
func (i Instruction) Operands() []Operand {
	if i.operands != nil {
		return i.operands
	}
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

// prepare resolves labels only after lowering has finished assigning PCs.
func (i *Instruction) prepare() {
	i.operands = i.Operands()
	for _, op := range generated.Machine.Instruction {
		if op.Name == i.Name {
			i.Cost, i.Suspends = op.Cost, op.Suspends
			break
		}
	}
	if i.Name == "call-builtin" && len(i.operands) > 0 {
		i.Cost = "builtin." + i.operands[0].Text
	}
	i.Rate = -1
	if rate, ok := generated.CostRateIndex[i.Cost]; ok {
		i.Rate = rate
	}
}
