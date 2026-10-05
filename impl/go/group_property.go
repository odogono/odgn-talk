package northtalk

import (
	"fmt"
	"slices"
	"unicode/utf8"

	"github.com/odogono/odgn-talk/impl/go/internal/generated"
	"github.com/odogono/odgn-talk/impl/go/internal/machine"
	"github.com/odogono/odgn-talk/impl/go/internal/shape"
	coretrace "github.com/odogono/odgn-talk/impl/go/internal/trace"
	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
)

func (g *Group) property(s *Script, x *execution, object corevalue.Value, name string, set bool, input corevalue.Value, pay func(int64, int64) bool, reports *[]Report, boundary func()) (corevalue.Value, *corevalue.Value) {
	wasCancelling := x.run.Cancelling
	o := object.Object.Handle.(*Object) // only Group-checked Values reach execution
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
	result, err := invokeProperty(prop, o, set, Value{input})
	fields := map[string]string{"object": coretrace.Display(object), "name": name, "op": "get"}
	if set {
		fields["op"] = "set"
		fields["value"] = coretrace.Display(input)
	}
	record := func() { g.record("prop", false, []string{string(x.id)}, fields); boundary() }
	named := []corevalue.Pair{{Key: "capability", Val: mustText(o.kind.name)}, {Key: "operation", Val: mustText(name)}}
	hostError := func(detail string) (corevalue.Value, *corevalue.Value) {
		*reports = append(*reports, &CallFailed{Script: s.name, Operation: OperationRef{Capability: o.kind.name, Operation: name}, Detail: detail})
		return fail("host error", named...)
	}
	conversion := func(v corevalue.Value) bool {
		if x.run.Status == machine.Stopped || !wasCancelling && x.run.Cancelling {
			return false
		}
		fuel, alloc := machine.Charge("capability", machine.Measures{Result: v, ResultPresent: true})
		return x.run.PayHost(fuel-10, alloc)
	}
	if err != nil {
		e, ok := err.(*ScriptError)
		if !ok || e == nil || !utf8.ValidString(e.Code) || !utf8.ValidString(e.Message) {
			fields["error"] = "{}"
			record()
			return hostError(fmt.Sprint(err))
		}
		data := e.Data.inner
		if data.Kind != corevalue.Map && data.Kind != corevalue.Nothing {
			fields["error"] = "{}"
			record()
			return hostError("failure Data is neither a map nor Nothing")
		}
		if data.Kind == corevalue.Nothing {
			data, _ = corevalue.NewMap(nil)
		}
		failed := []corevalue.Pair{{Key: "code", Val: mustText(e.Code)}}
		if e.Message != "" {
			failed = append(failed, corevalue.Pair{Key: "message", Val: mustText(e.Message)})
		}
		failed = append(failed, data.Entries...)
		if !validGroup(data, g) {
			fields["error"] = "{}"
			record()
			return hostError("failure holds a value from another Group")
		}
		v, mapError := corevalue.NewMap(failed)
		if mapError != nil {
			fields["error"] = "{}"
			record()
			return hostError("failure uses a reserved Data key")
		}
		fields["error"] = coretrace.Display(v)
		record()
		for _, d := range generated.Errors.Error {
			if d.Code == e.Code {
				return hostError("failure uses a catalogue code")
			}
		}
		for _, p := range data.Entries {
			if slices.Contains(generated.Errors.Reserved, p.Key) {
				return hostError("failure uses a reserved Data key")
			}
		}
		if !conversion(data) {
			return corevalue.Value{}, nil
		}
		failed = append(failed, named...)
		v, _ = corevalue.NewMap(failed)
		return corevalue.Value{}, &v
	}
	if set {
		record()
		return corevalue.Value{}, nil
	}
	if !validGroup(result.inner, g) || shape.Check(result.inner, prop.Shape.inner, nil) != nil {
		fields["error"] = "{}"
		record()
		return hostError("result violates its Shape or Group ownership")
	}
	fields["value"] = coretrace.Display(result.inner)
	record()
	if !conversion(result.inner) {
		return corevalue.Value{}, nil
	}
	return result.inner, nil
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
