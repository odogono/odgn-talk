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
func (g *Group) operation(s *Script, x *execution, grantName, opName string, args []corevalue.Value, pay func(int64, int64) bool, reports *[]Report, boundary func()) (corevalue.Value, *corevalue.Value, bool) {
	wasCancelling := x.run.Cancelling
	grant := s.grants[grantName]
	op := grant.definition.ops[opName]
	named := []corevalue.Pair{{Key: "capability", Val: mustText(grantName)}, {Key: "operation", Val: mustText(opName)}}
	fail := func(code string, fields ...corevalue.Pair) (corevalue.Value, *corevalue.Value, bool) {
		err := operationError(code, fields)
		return corevalue.Value{}, &err, false
	}
	if grant.disabled {
		return fail("capability disabled", named...)
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
	if check := grant.definition.checks[opName].arguments; check != nil {
		if err := check(args, grant.binding); err != nil {
			return corevalue.Value{}, err, false
		}
	}
	if op.Mode == Suspending && x.run.OpenScope != nil {
		err := x.run.OpenScope.Error()
		return corevalue.Value{}, &err, false
	}
	if scope := op.Scope; scope != nil {
		code, name := "", scope.Closes
		if scope.Opens != "" {
			name = scope.Opens
			if x.scopeIndex(grantName, name) >= 0 {
				code = "scope already open"
			} else if x.run.Join != nil {
				code = "scope in join"
			}
		} else if x.scopeIndex(grantName, name) < 0 {
			code = "scope not open"
		}
		if code != "" {
			err := scopeError(code, grantName, opName, name)
			return corevalue.Value{}, &err, false
		}
	}
	if op.SegmentBound && x.participant != nil && x.participant.name != grantName {
		fields := append(named, corevalue.Pair{Key: "participant", Val: mustText(x.participant.name)})
		return fail("segment participant conflict", fields...)
	}
	fuel, _ := machine.Charge("capability", machine.Measures{Declared: op.Cost.Fuel})
	if !pay(fuel, op.Cost.Alloc) {
		return corevalue.Value{}, nil, false
	}
	g.writeRaises(x, x.raisesWritten)
	if op.SegmentBound && x.participant == nil {
		if failure := g.enrollParticipant(s, x, grantName, grant, reports); failure != nil {
			if failure.Status == EffectUnknown {
				return corevalue.Value{}, nil, false
			}
			return fail("host error", named...)
		}
	}
	x.calls++
	ctx, cancel := operationContext(op.Mode)
	call := &Call{group: g, scriptName: s.name, runID: x.id, grantName: grantName, binding: grant.binding, id: CallID(fmt.Sprintf("%s.c%d", x.id, x.calls)), segmentID: fmt.Sprintf("%s.s%d", x.id, x.segment), now: g.clock, context: ctx, starting: true, charge: x.run.ChargeHost}
	if op.Scope != nil {
		call.scopeName = op.Scope.Closes
		if op.Scope.Opens != "" {
			call.scopeName = op.Scope.Opens
		}
	}
	vs := make([]Value, len(args))
	for i, v := range args {
		vs[i] = Value{v}
	}
	result, err := invokeOperation(op, call, vs)
	call.finish()
	action := ""
	if err == nil {
		action = x.acknowledgeScope(grantName, grant, op)
	}
	fields := map[string]string{"op": grantName + "." + opName, "args": coretrace.Display(corevalue.NewList(args))}
	if call.charged != 0 {
		fields["charged"] = fmt.Sprint(call.charged)
	}
	record := func() {
		g.record("call", false, []string{string(call.id)}, fields)
		if action != "" {
			g.record("scope", false, []string{string(call.id)}, map[string]string{"grant": grantName, "name": call.scopeName, "action": action})
		}
		boundary()
	}
	if call.reached || errors.Is(err, ErrLimit) {
		record()
		cancel()
		if x.run.Status != machine.Stopped {
			x.run.FaultHostFuel()
		}
		return corevalue.Value{}, nil, false
	}
	if op.Mode == Suspending && err == nil {
		if g.calls == nil {
			g.calls = map[CallID]*operationCall{}
		}
		g.calls[call.id] = &operationCall{call: call, cancel: cancel, s: s, x: x, op: op, name: opName, pending: true, args: slices.Clone(vs), rebound: true}
		if x.run.Join != nil {
			x.run.AddJoinMember(string(call.id))
			x.run.Join.Members[len(x.run.Join.Members)-1].WaitMS = int64(operationWait(op, x) / time.Millisecond)
		} else {
			x.waitCall = call.id
			x.run.SendWait = true
			x.run.OperationWait = true
		}
		record()
		return corevalue.Value{}, nil, false
	}
	if op.Mode == Suspending {
		cancel()
	}
	return g.completeOperation(s, x, grantName, opName, op, call, args, result, err, fields, record, 0, reports, wasCancelling)
}

// completeOperation runs on the Run's turn, so validation and conversion belong
// to the resuming Segment, including a failure's Data.
func (g *Group) completeOperation(s *Script, x *execution, grantName, opName string, op Operation, call *Call, args []corevalue.Value, result Value, err error, fields map[string]string, record func(), lateFuel int64, reports *[]Report, wasCancelling bool) (corevalue.Value, *corevalue.Value, bool) {
	grant := s.grants[grantName]
	named := []corevalue.Pair{{Key: "capability", Val: mustText(grantName)}, {Key: "operation", Val: mustText(opName)}}
	fail := func(code string, fields ...corevalue.Pair) (corevalue.Value, *corevalue.Value, bool) {
		e := operationError(code, fields)
		return corevalue.Value{}, &e, false
	}
	hostError := func(detail string) (corevalue.Value, *corevalue.Value, bool) {
		if call.automatic {
			call.failureDetail = detail
			return fail("host error", named...)
		}
		g.record("call-failed", false, []string{string(call.id)}, map[string]string{"op": grantName + "." + opName})
		*reports = append(*reports, &CallFailed{Script: s.name, Call: call.id, Operation: OperationRef{Capability: grant.definition.name, Operation: opName}, Detail: detail})
		return fail("host error", named...)
	}
	conversion := func(v corevalue.Value, late int64) bool {
		if call.automatic {
			return true
		}
		if x.run.Status == machine.Stopped || !wasCancelling && x.run.Cancelling {
			return false
		}
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
		if data.Kind != corevalue.Map && data.Kind != corevalue.Nothing {
			fields["error"] = "{}"
			if record != nil {
				record()
			}
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
		bad := ""
		if !validGroup(data, g) {
			bad = "failure holds a value from another Group"
		}
		if bad != "" {
			fields["error"] = "{}"
		} else {
			v, mapError := corevalue.NewMap(failed)
			if mapError != nil {
				fields["error"] = "{}"
				bad = "failure uses a reserved Data key"
			} else {
				fields["error"] = coretrace.Display(v)
			}
		}
		if record != nil {
			record()
		}
		for _, d := range generated.Errors.Error {
			if d.Code == e.Code {
				check := grant.definition.checks[opName].failure
				if check == nil || !check(e.Code, data) {
					bad = "failure uses an undeclared or malformed catalogue code"
				}
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
	checkResult := grant.definition.checks[opName].result
	if !validGroup(result.inner, g) || shape.Check(result.inner, op.Result.inner, nil) != nil || checkResult != nil && !checkResult(result.inner, args) {
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
	if c.group.sessionExpose != nil {
		c.group.sessionExpose(List(args...))
	}
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
