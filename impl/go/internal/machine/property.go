package machine

import (
	"math/big"

	"github.com/odogono/odgn-talk/impl/go/internal/generated"
	"github.com/odogono/odgn-talk/impl/go/internal/lower"
	"github.com/odogono/odgn-talk/impl/go/internal/value"
)

// PropertyFunc belongs to one execution turn. The Group adapter pays the
// instruction and declaration atomically before calling Get or Set, then
// validates and converts a Get result or failure on the same turn.
//
// An Object Element Reference or Element Count (#1143) arrives with name
// "elements" and op "at", "find", "count" or "none", input its selector,
// after the machine has paid its base rate and checked selector and receiver
// kinds. "none" selects nothing: zero, or a position past 2^53 - 1. The
// adapter still checks disposal and collection support first.
type PropertyFunc func(object value.Value, name, op string, input value.Value, pay func(int64, int64) bool) (value.Value, *value.Value)

type propertyCall struct {
	object, input value.Value
	name          string
	set           bool
	pops          int
	// op is set only for a collection read; failed is its Core-raised
	// selector or receiver error.
	op     string
	failed *value.Value
}

// maxElementIndex is the largest position a collection can have, 2^53 - 1.
const maxElementIndex = 9007199254740991

// elementRequest decodes get-element (selector, then receiver on top) or
// count-elements. Selector kind and integrality are checked before the
// receiver's kind; the caller pays the base rate first.
func elementRequest(f *Frame, i lower.Instruction) *propertyCall {
	if i.Op == generated.OpCountElements {
		call := &propertyCall{object: f.Stack[len(f.Stack)-1], name: "elements", op: "count", pops: 1}
		if call.object.Kind != value.Object {
			e := wrong("object", call.object)
			call.failed = &e
		}
		return call
	}
	selector := f.Stack[len(f.Stack)-2]
	call := &propertyCall{object: f.Stack[len(f.Stack)-1], input: selector, name: "elements", pops: 2}
	switch selector.Kind {
	case value.Text:
		call.op = "find"
	case value.Number:
		n, ok := selector.Number().Integer()
		if !ok {
			e := wrong("integer", selector)
			call.op, call.failed = "at", &e
			return call
		}
		call.op = "at"
		if n.Sign() == 0 || n.CmpAbs(big.NewInt(maxElementIndex)) > 0 {
			call.op = "none"
		}
	default:
		e := wrong("number or text", selector)
		call.op, call.failed = "at", &e
		return call
	}
	if call.object.Kind != value.Object {
		e := wrong("object", call.object)
		call.failed = &e
	}
	return call
}

// charge is a collection read's base instruction rate.
func (c *propertyCall) charge(i lower.Instruction) (int64, int64) {
	if i.Op == generated.OpCountElements {
		return Charge("count-elements", Measures{})
	}
	return Charge("get-element", Measures{Input: c.input, InputPresent: true})
}

func propertyRequest(f *Frame, i lower.Instruction) *propertyCall {
	set := i.Op == generated.OpSetProperty || i.Op == generated.OpSetPropertyComputed
	if !set && i.Op != generated.OpGetKey && i.Op != generated.OpGetKeyComputed {
		return nil
	}
	pops := 1
	if set {
		pops++
	}
	object := f.Stack[len(f.Stack)-pops]
	if object.Kind != value.Object {
		return nil
	}
	computed := i.Op == generated.OpGetKeyComputed || i.Op == generated.OpSetPropertyComputed
	name := ""
	if computed {
		pops++
		k := f.Stack[len(f.Stack)-pops]
		if k.Kind != value.Text {
			return nil
		} // ordinary instruction raises wrong kind
		name = k.Text()
	} else {
		v, _ := constant(i.Operands()[0].Text)
		name = v.Text()
	}
	if !set && name == "id" {
		return nil
	} // Core metadata needs no Host crossing
	call := &propertyCall{object: object, name: name, set: set, pops: pops}
	if set {
		call.input = f.Stack[len(f.Stack)-1]
	}
	return call
}

func inGuard(f *Frame) bool {
	for _, u := range f.Code.Unit.Bodies[f.Body].UnwindEntries() {
		if u.Kind == "guard" && f.PC >= u.First && f.PC <= u.Last {
			return true
		}
	}
	return false
}
