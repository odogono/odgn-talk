package northtalk

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/odogono/odgn-talk/impl/go/internal/machine"
	"github.com/odogono/odgn-talk/impl/go/internal/shape"
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
		if err := check(args, grant.binding, named); err != nil {
			return corevalue.Value{}, err, false
		}
	}
	// An `ask … and wait` reached after its Timeout Block's deadline raises
	// at once (ADR 0073). A Join Member isn't a Suspension Point.
	if op.Mode == Suspending && x.run.At.Name == "ask-wait" {
		if err := x.run.DeadlineError(named...); err != nil {
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
	if op.SegmentBound && x.participant != nil && x.participant.coordinator != grant.coordinator {
		fields := append(named, corevalue.Pair{Key: "participant", Val: mustText(x.participant.name())})
		return fail("segment participant conflict", fields...)
	}
	fuel, _ := machine.Charge("capability", machine.Measures{Declared: op.Cost.Fuel})
	if !pay(fuel, op.Cost.Alloc) {
		return corevalue.Value{}, nil, false
	}
	g.writeRaises(x, x.raisesWritten)
	if op.SegmentBound {
		if failure := g.enrollParticipant(s, x, grantName, grant, reports); failure != nil {
			if failure.Status == EffectUnknown {
				return corevalue.Value{}, nil, false
			}
			return fail("host error", named...)
		}
	}
	x.calls++
	ctx, cancel := operationContext(op.Mode)
	call := &Call{group: g, scriptName: s.name, runID: x.id, grantName: grantName, binding: grant.binding, id: CallID(fmt.Sprintf("%s.c%d", x.id, x.calls)), segmentID: fmt.Sprintf("%s.s%d", x.id, x.segment), now: g.clock, context: ctx, starting: true, charge: x.run.ChargeHost, fuelLeft: x.run.HostFuelLeft}
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
	crossing := operationHostCrossing(s, x, grantName, opName, op, call, args)
	v, failure := g.crossHost(crossing, func() (Value, error) {
		result, err := invokeOperation(op, call, vs)
		call.finish()
		if err == nil {
			crossing.scopeAction = x.acknowledgeScope(grantName, grant, op)
		}
		if call.charged != 0 {
			crossing.fields["charged"] = fmt.Sprint(call.charged)
		}
		if call.reached || errors.Is(err, ErrLimit) {
			crossing.fuelExhausted = true
			crossing.cancel = cancel
			return result, err
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
			crossing.pending = true
		} else if op.Mode == Suspending {
			cancel()
		}
		return result, err
	}, boundary, reports)
	return v, failure, false
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
