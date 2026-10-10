package northtalk

import (
	"fmt"

	"github.com/odogono/odgn-talk/impl/go/internal/machine"
	"github.com/odogono/odgn-talk/impl/go/internal/shape"
	coretrace "github.com/odogono/odgn-talk/impl/go/internal/trace"
	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
)

func (g *Group) property(s *Script, x *execution, object corevalue.Value, name string, set bool, input corevalue.Value, pay func(int64, int64) bool, reports *[]Report, boundary func()) (corevalue.Value, *corevalue.Value) {
	o := object.Object().Handle.(*Object) // only Group-checked Values reach execution
	key := "get-key"
	if set {
		key = "set-property"
	}
	fail := func(code string, fields ...corevalue.Pair) (corevalue.Value, *corevalue.Value) {
		err := machine.ErrorValue(code, fields...)
		return corevalue.Value{}, &err
	}
	// Operand/domain failures pay only the instruction rate, without a Host call.
	invalid := func(code string, fields ...corevalue.Pair) (corevalue.Value, *corevalue.Value) {
		fuel, alloc := machine.Charge(key, machine.Measures{})
		if !pay(fuel, alloc) {
			return corevalue.Value{}, nil
		}
		return fail(code, fields...)
	}
	if o.disposed.Load() {
		return invalid("object gone", corevalue.Pair{Key: "object", Val: object})
	}
	prop, found := o.kind.props[name]
	if set && (!found || prop.Set == nil) {
		return invalid("read only")
	}
	if !found {
		fuel, alloc := machine.Charge(key, machine.Measures{})
		pay(fuel, alloc)
		return corevalue.Value{}, nil
	}
	if set {
		if m := shape.Check(input, prop.Shape.inner, nil); m != nil {
			fields := []corevalue.Pair{{Key: "expected", Val: mustText(m.Expected)}, {Key: "got", Val: mustText(m.Got)}, {Key: "value", Val: m.Value}}
			if len(m.Path) > 0 {
				fields = append(fields, corevalue.Pair{Key: "path", Val: corevalue.NewList(m.Path)})
			}
			return fail("wrong kind", fields...)
		}
	}
	cost := prop.GetCost
	measures := machine.Measures{}
	if set {
		cost = prop.SetCost
		measures.Input = input
		measures.InputPresent = true
	}
	fuel, _ := machine.Charge(key, measures)
	if !pay(fuel+cost.Fuel, cost.Alloc) {
		return corevalue.Value{}, nil
	}
	g.writeRaises(x, x.raisesWritten)
	crossing := &hostCrossing{
		script: s, execution: x,
		operation: OperationRef{Capability: o.kind.name, Operation: name},
		fields:    map[string]string{"object": coretrace.Display(object), "name": name, "op": "get"},
		resultKey: "value", ignoreResult: set,
		convert: func(v corevalue.Value) bool { return shape.Check(v, prop.Shape.inner, nil) == nil },
	}
	if set {
		crossing.fields["op"] = "set"
		crossing.fields["value"] = coretrace.Display(input)
	}
	return g.crossHost(crossing, func() (Value, error) {
		return invokeProperty(prop, o, set, Value{input})
	}, boundary, reports)
}

func invokeProperty(prop Prop, o *Object, set bool, input Value) (v Value, err error) {
	defer func() {
		if caught := recover(); caught != nil {
			err = fmt.Errorf("Host panic: %v", caught)
		}
	}()
	if set {
		return Nothing, prop.Set(o, input)
	}
	return prop.Get(o)
}
