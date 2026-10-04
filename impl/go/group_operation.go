package northtalk

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/odogono/odgn-talk/impl/go/internal/generated"
	"github.com/odogono/odgn-talk/impl/go/internal/machine"
	"github.com/odogono/odgn-talk/impl/go/internal/shape"
	coretrace "github.com/odogono/odgn-talk/impl/go/internal/trace"
	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
)

type OperationRef struct{ Capability, Operation string }
type CallFailed struct {
	Script    string
	Call      CallID
	Operation OperationRef
	Detail    string
}

func (*CallFailed) isReport() {}
func (g *Group) operation(s *Script, x *execution, grantName, opName string, args []corevalue.Value, pay func(int64, int64) bool, reports *[]Report) (corevalue.Value, *corevalue.Value, bool) {
	// Library Capability calls wait for import-time needs validation and trimming.
	// Preserve the unpaid instruction and its operands at this boundary.
	if x.run.CurrentCode().Unit.Kind == "library" {
		return corevalue.Value{}, nil, true
	}
	grant := s.grants[grantName]
	op := grant.definition.ops[opName]
	named := []corevalue.Pair{{Key: "capability", Val: mustText(grantName)}, {Key: "operation", Val: mustText(opName)}}
	fail := func(code string, fields ...corevalue.Pair) (corevalue.Value, *corevalue.Value, bool) {
		err := operationError(code, fields)
		return corevalue.Value{}, &err, false
	}
	if grant.revoked {
		return fail("capability revoked", named...)
	}
	for i, arg := range args {
		if m := shape.Check(arg, op.Args[i].inner, nil); m != nil {
			if m.Unencodable {
				path := append([]corevalue.Value{Int(int64(i + 1)).inner}, m.Path...)
				return fail("not encodable", corevalue.Pair{Key: "kind", Val: mustText(m.Got)}, corevalue.Pair{Key: "path", Val: corevalue.NewList(path)})
			}
			fields := []corevalue.Pair{{Key: "expected", Val: mustText(m.Expected)}, {Key: "got", Val: mustText(m.Got)}, {Key: "value", Val: m.Value}}
			fields = append(fields, named...)
			fields = append(fields, corevalue.Pair{Key: "argument", Val: Int(int64(i + 1)).inner})
			if len(m.Path) > 0 {
				fields = append(fields, corevalue.Pair{Key: "path", Val: corevalue.NewList(m.Path)})
			}
			return fail("wrong kind", fields...)
		}
	}
	fuel, _ := machine.Charge("capability", machine.Measures{Declared: op.Cost.Fuel})
	if !pay(fuel, op.Cost.Alloc) {
		return corevalue.Value{}, nil, false
	}
	g.writeRaises(x, x.raisesWritten)
	x.calls++
	ctx, cancel := operationContext(op.Mode)
	call := &Call{group: g, scriptName: s.name, runID: x.id, grantName: grantName, binding: grant.binding, id: CallID(fmt.Sprintf("%s.c%d", x.id, x.calls)), segmentID: fmt.Sprintf("%s.s%d", x.id, x.segment), now: g.clock, context: ctx, starting: true, charge: x.run.ChargeHost}
	vs := make([]Value, len(args))
	for i, v := range args {
		vs[i] = Value{v}
	}
	result, err := invokeOperation(op, call, vs)
	call.finish()
	fields := map[string]string{"op": grantName + "." + opName, "args": coretrace.Display(corevalue.NewList(args))}
	if call.charged != 0 {
		fields["charged"] = fmt.Sprint(call.charged)
	}
	record := func() { g.record("call", false, []string{string(call.id)}, fields) }
	if call.reached || errors.Is(err, ErrLimit) {
		record()
		cancel()
		x.run.FaultHostFuel()
		return corevalue.Value{}, nil, false
	}
	if op.Mode == Suspending && err == nil {
		record()
		if g.calls == nil {
			g.calls = map[CallID]*operationCall{}
		}
		g.calls[call.id] = &operationCall{call: call, cancel: cancel, s: s, x: x, op: op, name: opName, pending: true}
		if x.run.Join != nil {
			x.run.AddJoinMember(string(call.id))
			x.run.Join.Members[len(x.run.Join.Members)-1].WaitMS = int64(operationWait(op, x) / time.Millisecond)
		} else {
			x.waitCall = call.id
			x.run.SendWait = true
			x.run.OperationWait = true
		}
		return corevalue.Value{}, nil, false
	}
	if op.Mode == Suspending {
		cancel()
	}
	return g.completeOperation(s, x, grantName, opName, op, call, result, err, fields, record, 0, reports)
}

// completeOperation runs on the Run's turn, so validation and conversion belong
// to the resuming Segment, including a failure's Data.
func (g *Group) completeOperation(s *Script, x *execution, grantName, opName string, op Operation, call *Call, result Value, err error, fields map[string]string, record func(), lateFuel int64, reports *[]Report) (corevalue.Value, *corevalue.Value, bool) {
	grant := s.grants[grantName]
	named := []corevalue.Pair{{Key: "capability", Val: mustText(grantName)}, {Key: "operation", Val: mustText(opName)}}
	fail := func(code string, fields ...corevalue.Pair) (corevalue.Value, *corevalue.Value, bool) {
		e := operationError(code, fields)
		return corevalue.Value{}, &e, false
	}
	hostError := func(detail string) (corevalue.Value, *corevalue.Value, bool) {
		g.record("call-failed", false, []string{string(call.id)}, map[string]string{"op": grantName + "." + opName})
		*reports = append(*reports, &CallFailed{Script: s.name, Call: call.id, Operation: OperationRef{Capability: grant.definition.name, Operation: opName}, Detail: detail})
		return fail("host error", named...)
	}
	conversion := func(v corevalue.Value, late int64) bool {
		after, alloc := machine.Charge("capability", machine.Measures{Declared: op.Cost.Fuel, Result: v, ResultPresent: true})
		return x.run.PayHost(after-10-op.Cost.Fuel+late, alloc)
	}
	if err != nil {
		e, ok := err.(*ScriptError)
		if !ok || e == nil {
			fields["error"] = "{}"
			if record != nil {
				record()
			}
			return hostError(fmt.Sprint(err))
		}
		data := e.Data.inner
		if data.Kind != corevalue.Map {
			data, _ = corevalue.NewMap(nil)
		}
		failed := []corevalue.Pair{{Key: "code", Val: mustText(e.Code)}}
		if e.Message != "" {
			failed = append(failed, corevalue.Pair{Key: "message", Val: mustText(e.Message)})
		}
		failed = append(failed, data.Entries...)
		bad := ""
		if !validGroup(data, g) {
			bad = "failure holds a value from another Group"
		}
		if bad != "" {
			fields["error"] = "{}"
		} else {
			v, _ := corevalue.NewMap(failed)
			fields["error"] = coretrace.Display(v)
		}
		if record != nil {
			record()
		}
		for _, d := range generated.Errors.Error {
			if d.Code == e.Code {
				bad = "failure uses a catalogue code"
			}
		}
		for _, p := range data.Entries {
			if slices.Contains(generated.Errors.Reserved, p.Key) {
				bad = "failure uses a reserved Data key"
			}
		}
		if op.Errors != nil {
			found := false
			for _, d := range op.Errors {
				if d.Code == e.Code {
					found = true
				}
			}
			if !found {
				bad = "failure is outside the declared codes"
			}
		}
		if bad != "" {
			return hostError(bad)
		}
		if !conversion(data, 0) {
			return corevalue.Value{}, nil, false
		}
		failed = append(failed, named...)
		v, _ := corevalue.NewMap(failed)
		return corevalue.Value{}, &v, false
	}
	if op.Mode == FireAndForget {
		if record != nil {
			record()
		}
		return corevalue.Value{}, nil, false
	}
	if !validGroup(result.inner, g) || shape.Check(result.inner, op.Result.inner, nil) != nil {
		fields["error"] = "{}"
		if record != nil {
			record()
		}
		return hostError("result violates its Shape or Group ownership")
	}
	fields["result"] = coretrace.Display(result.inner)
	if record != nil {
		record()
	}
	if !conversion(result.inner, lateFuel) {
		return corevalue.Value{}, nil, false
	}
	return result.inner, nil, false
}
func invokeOperation(op Operation, c *Call, args []Value) (v Value, err error) {
	defer func() {
		if caught := recover(); caught != nil {
			err = fmt.Errorf("Host panic: %v", caught)
		}
	}()
	if op.Mode == Immediate {
		return op.Do(c, args)
	}
	if op.Mode == Suspending {
		return Nothing, op.Start(c, args)
	}
	return Nothing, op.Fire(c, args)
}
func operationError(code string, fields []corevalue.Pair) corevalue.Value {
	return machine.ErrorValue(code, fields...)
}

func operationContext(mode Mode) (context.Context, context.CancelFunc) {
	if mode == Suspending {
		return context.WithCancel(context.Background())
	}
	return context.Background(), func() {}
}
