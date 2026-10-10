package machine

import (
	"maps"

	"github.com/odogono/odgn-talk/impl/go/internal/value"
)

// frameTrial lets an instruction evaluate on its live frame instead of a
// copy. It keeps whatever the instruction overwrites, so an instruction that
// raises or can't pay leaves the frame as it found it: nothing commits before
// the charge succeeds.
//
// Writes reach the stack only at its current length, so slots below the
// lowest length the instruction has reached still hold their originals, in
// whichever buffer the stack now uses. Popping below that mark keeps the
// slots it exposes. Receiver names are copied on first write, because
// retained frames may share the map.
type frameTrial struct {
	stack    []value.Value // the live stack before the instruction
	low      int           // the lowest stack length reached
	popped   []value.Value // originals of stack[low:], from the top down
	locals   []localWrite
	names    map[int]string
	ownNames bool // names were copied for this instruction
	pc       int
	waiting  bool
}

type localWrite struct {
	slot int
	was  value.Value
}

func (t *frameTrial) begin(f *Frame) {
	t.stack, t.low, t.popped, t.locals = f.Stack, len(f.Stack), t.popped[:0], t.locals[:0]
	t.names, t.ownNames, t.pc, t.waiting = f.ReceiverNames, false, f.PC, f.Waiting
}

// shrink pops the stack to n slots.
func (t *frameTrial) shrink(f *Frame, n int) {
	for ; t.low > n; t.low-- {
		t.popped = append(t.popped, f.Stack[t.low-1])
	}
	f.Stack = f.Stack[:n]
}

// operand returns stack slot j as it was before the instruction.
func (t *frameTrial) operand(j int) value.Value {
	if j < t.low {
		return t.stack[j]
	}
	return t.popped[len(t.stack)-1-j]
}

func (t *frameTrial) setLocal(f *Frame, slot int, v value.Value) {
	t.locals = append(t.locals, localWrite{slot, f.Locals[slot]})
	f.Locals[slot] = v
}

// writeNames returns the frame's receiver names, ready to change.
func (t *frameTrial) writeNames(f *Frame) map[int]string {
	if !t.ownNames {
		f.ReceiverNames = maps.Clone(f.ReceiverNames)
		t.ownNames = true
	}
	if f.ReceiverNames == nil {
		f.ReceiverNames = map[int]string{}
	}
	return f.ReceiverNames
}

// dropNames forgets the receiver names at or above stack slot n.
func (t *frameTrial) dropNames(f *Frame, n int) {
	if len(f.ReceiverNames) == 0 {
		return
	}
	for slot := range f.ReceiverNames {
		if slot >= n {
			delete(t.writeNames(f), slot)
		}
	}
}

// restore undoes the instruction's changes to the frame.
func (t *frameTrial) restore(f *Frame) {
	for k, v := range t.popped {
		t.stack[len(t.stack)-1-k] = v
	}
	for j := len(t.locals) - 1; j >= 0; j-- {
		f.Locals[t.locals[j].slot] = t.locals[j].was
	}
	f.Stack, f.ReceiverNames, f.PC, f.Waiting = t.stack, t.names, t.pc, t.waiting
}
