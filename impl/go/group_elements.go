package northtalk

import (
	"fmt"
	"math/big"

	"github.com/odogono/odgn-talk/impl/go/internal/machine"
	"github.com/odogono/odgn-talk/impl/go/internal/shape"
	coretrace "github.com/odogono/odgn-talk/impl/go/internal/trace"
	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
)

// maxElementCount is the largest count a collection can have, 2^53 - 1.
const maxElementCount = 9007199254740991

// elements answers `element s of o` or `the number of elements of o` (#1143)
// after the machine has paid the base rate and checked the selector's and
// receiver's kinds. Disposal and collection support are checked here, then
// one Host callback answers, charged and recorded as a property getter is.
// Op "none" selects nothing without a callback.
func (g *Group) elements(s *Script, x *execution, object corevalue.Value, op string, selector corevalue.Value, pay func(int64, int64) bool, reports *[]Report, boundary func()) (corevalue.Value, *corevalue.Value) {
	o := object.Object().Handle.(*Object) // only Group-checked Values reach execution
	if o.disposed.Load() {
		err := machine.ErrorValue("object gone", corevalue.Pair{Key: "object", Val: object})
		return corevalue.Value{}, &err
	}
	e := o.kind.elements
	if e == nil {
		function := "element"
		if op == "count" {
			function = "number of elements"
		}
		err := machine.ErrorValue("out of domain", corevalue.Pair{Key: "function", Val: mustText(function)}, corevalue.Pair{Key: "value", Val: object})
		return corevalue.Value{}, &err
	}
	if op == "none" {
		return corevalue.Value{}, nil
	}
	var index int64
	var cost Cost
	var invoke func() (Value, error)
	switch op {
	case "count":
		cost = e.CountCost
		invoke = func() (Value, error) { return e.Count(o) }
	case "at":
		index, _ = selector.Number().Int64()
		selector = Int(index).inner
		cost = e.AtCost
		invoke = func() (Value, error) { return e.At(o, index) }
	default:
		name := selector.Text()
		cost = e.FindCost
		invoke = func() (Value, error) { return e.Find(o, name) }
	}
	if !pay(cost.Fuel, cost.Alloc) {
		return corevalue.Value{}, nil
	}
	g.writeRaises(x, x.raisesWritten)
	crossing := &hostCrossing{
		script: s, execution: x,
		operation: OperationRef{Capability: o.kind.name, Operation: "elements." + op},
		fields:    map[string]string{"name": "elements", "op": op},
		resultKey: "value",
		check: func(v corevalue.Value) string {
			return g.elementResultDetail(e, op, v)
		},
	}
	if g.options.Trace != nil {
		crossing.fields["object"] = coretrace.Display(object)
		if op != "count" {
			crossing.fields["selector"] = coretrace.Display(selector)
		}
	}
	return g.crossHost(crossing, func() (v Value, err error) {
		defer func() {
			if caught := recover(); caught != nil {
				err = fmt.Errorf("Host panic: %v", caught)
			}
		}()
		return invoke()
	}, boundary, reports)
}

// elementResultDetail says what is wrong with a collection callback's
// result, or nothing. Group ownership is checked before this.
func (g *Group) elementResultDetail(e *ObjectElements, op string, v corevalue.Value) string {
	if op == "count" {
		if v.Kind != corevalue.Number {
			return "its count is not a number"
		}
		n, ok := v.Number().Integer()
		if !ok || n.Sign() < 0 || n.Cmp(big.NewInt(maxElementCount)) > 0 {
			return "its count is not an integer from 0 to 2^53 - 1"
		}
		return ""
	}
	if v.Kind == corevalue.Nothing {
		return ""
	}
	if shape.Check(v, e.Shape.inner, nil) != nil {
		return "result violates its Shape"
	}
	if member, ok := v.Object().Handle.(*Object); !ok || member.disposed.Load() {
		return "its member is disposed"
	}
	return ""
}
