package northtalk

import (
	"context"
	"fmt"
	"slices"
	"unicode/utf8"

	"github.com/odogono/odgn-talk/impl/go/internal/generated"
	"github.com/odogono/odgn-talk/impl/go/internal/machine"
	"github.com/odogono/odgn-talk/impl/go/internal/shape"
	coretrace "github.com/odogono/odgn-talk/impl/go/internal/trace"
	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
)

// hostCrossing holds the Operation or property's declaration and invocation
// state. A nil call identifies a property, which has no call-failed record.
type hostCrossing struct {
	script        *Script
	execution     *execution
	operation     OperationRef
	call          *Call
	op            Operation
	checks        operationChecks
	convert       func(corevalue.Value) bool
	fields        map[string]string
	resultKey     string
	ignoreResult  bool
	scopeAction   string
	pending       bool
	fuelExhausted bool
	cancel        context.CancelFunc
	wasCancelling bool
	lateFuel      int64
}

func operationHostCrossing(s *Script, x *execution, grantName, opName string, op Operation, call *Call, args []corevalue.Value) *hostCrossing {
	grant := s.grants[grantName]
	checks := grant.definition.checks[opName]
	return &hostCrossing{
		script: s, execution: x,
		operation: OperationRef{Capability: grant.definition.name, Operation: opName},
		call:      call, op: op, checks: checks,
		fields:    map[string]string{"op": grantName + "." + opName, "args": coretrace.Display(corevalue.NewList(args))},
		resultKey: "result", ignoreResult: op.Mode == FireAndForget,
		convert: func(v corevalue.Value) bool {
			return shape.Check(v, op.Result.inner, nil) == nil && (checks.result == nil || checks.result(v, args))
		},
	}
}

// crossHost owns the Host Crossing order: invoke, record, land, then classify.
// Declared costs and operand checks have already been paid by the caller.
func (g *Group) crossHost(c *hostCrossing, invoke func() (Value, error), boundary func(), reports *[]Report) (corevalue.Value, *corevalue.Value) {
	c.wasCancelling = c.execution.run.Cancelling
	result, err := invoke()
	record := func() {
		kind, id := "prop", string(c.execution.id)
		if c.call != nil {
			kind, id = "call", string(c.call.id)
		}
		g.record(kind, false, []string{id}, c.fields)
		if c.scopeAction != "" {
			g.record("scope", false, []string{id}, map[string]string{"grant": c.call.grantName, "name": c.call.scopeName, "action": c.scopeAction})
		}
		boundary()
	}
	if c.fuelExhausted {
		record()
		c.cancel()
		if c.execution.run.Status != machine.Stopped {
			c.execution.run.FaultHostFuel()
		}
		return corevalue.Value{}, nil
	}
	if c.pending {
		record()
		return corevalue.Value{}, nil
	}
	prepared := g.prepareHostResult(c, result, err)
	record()
	if c.interrupted() {
		return corevalue.Value{}, nil
	}
	return g.classifyHostResult(c, prepared, reports)
}

// resumeHost classifies on the resuming Run's turn. The suspended call already
// has its call record, and a settlement is not another Host Crossing.
func (g *Group) resumeHost(c *hostCrossing, result Value, err error, lateFuel int64, reports *[]Report) (corevalue.Value, *corevalue.Value) {
	c.wasCancelling = c.execution.run.Cancelling
	c.lateFuel = lateFuel
	prepared := g.prepareHostResult(c, result, err)
	if c.interrupted() {
		return corevalue.Value{}, nil
	}
	return g.classifyHostResult(c, prepared, reports)
}

func (c *hostCrossing) interrupted() bool {
	return c.execution.run.Status == machine.Stopped || !c.wasCancelling && c.execution.run.Cancelling
}

func (c *hostCrossing) automatic() bool {
	return c.call != nil && c.call.automatic
}

func (c *hostCrossing) named() []corevalue.Pair {
	capability := c.operation.Capability
	if c.call != nil {
		capability = c.call.grantName
	}
	return []corevalue.Pair{{Key: "capability", Val: mustText(capability)}, {Key: "operation", Val: mustText(c.operation.Operation)}}
}

func (g *Group) crossingHostError(c *hostCrossing, detail string, reports *[]Report) (corevalue.Value, *corevalue.Value) {
	if c.automatic() {
		c.call.failureDetail = detail
	} else {
		report := &CallFailed{Script: c.script.name, Operation: c.operation, Detail: detail}
		if c.call != nil {
			g.record("call-failed", false, []string{string(c.call.id)}, map[string]string{"op": c.fields["op"]})
			report.Call = c.call.id
		}
		*reports = append(*reports, report)
	}
	failure := machine.ErrorValue("host error", c.named()...)
	return corevalue.Value{}, &failure
}

func (c *hostCrossing) payConversion(v corevalue.Value, lateFuel int64) bool {
	if c.automatic() {
		return true
	}
	fuel, alloc := machine.Charge("capability", machine.Measures{Declared: c.op.Cost.Fuel, Result: v, ResultPresent: true})
	return c.execution.run.PayHost(fuel-10-c.op.Cost.Fuel+lateFuel, alloc)
}

// hostResult is prepared for the Trace before landing. Declaration validation,
// failure reports and conversion costs belong to classification after landing.
type hostResult struct {
	value   corevalue.Value
	failure *ScriptError
	data    corevalue.Value
	failed  []corevalue.Pair
	bad     string
	detail  string
	invalid bool
}

func (g *Group) prepareHostResult(c *hostCrossing, result Value, err error) hostResult {
	if err != nil {
		c.fields["error"] = "{}"
		e, ok := err.(*ScriptError)
		if !ok || e == nil || c.call == nil && (!utf8.ValidString(e.Code) || !utf8.ValidString(e.Message)) {
			return hostResult{detail: fmt.Sprint(err), invalid: true}
		}
		data := e.Data.inner
		if data.Kind != corevalue.Map && data.Kind != corevalue.Nothing {
			return hostResult{detail: "failure Data is neither a map nor Nothing", invalid: true}
		}
		if data.Kind == corevalue.Nothing {
			data, _ = corevalue.NewMap(nil)
		}
		failed := []corevalue.Pair{{Key: "code", Val: mustText(e.Code)}}
		if e.Message != "" {
			failed = append(failed, corevalue.Pair{Key: "message", Val: mustText(e.Message)})
		}
		failed = append(failed, data.Entries...)
		prepared := hostResult{failure: e, data: data, failed: failed}
		if !validGroup(data, g) {
			prepared.bad = "failure holds a value from another Group"
		} else if v, mapError := corevalue.NewMap(failed); mapError != nil {
			prepared.bad = "failure uses a reserved Data key"
		} else {
			c.fields["error"] = coretrace.Display(v)
		}
		return prepared
	}
	if c.ignoreResult {
		return hostResult{}
	}
	if !validGroup(result.inner, g) || !c.convert(result.inner) {
		c.fields["error"] = "{}"
		return hostResult{detail: "result violates its Shape or Group ownership", invalid: true}
	}
	c.fields[c.resultKey] = coretrace.Display(result.inner)
	return hostResult{value: result.inner}
}

func (g *Group) classifyHostResult(c *hostCrossing, result hostResult, reports *[]Report) (corevalue.Value, *corevalue.Value) {
	if result.invalid {
		return g.crossingHostError(c, result.detail, reports)
	}
	if e := result.failure; e != nil {
		data, bad := result.data, result.bad
		// Properties reject malformed Data before checking catalogue codes;
		// Operations retain the existing declaration-check precedence.
		if c.call == nil && bad != "" {
			return g.crossingHostError(c, bad, reports)
		}
		for _, d := range generated.Errors.Error {
			if d.Code == e.Code {
				if c.call == nil {
					return g.crossingHostError(c, "failure uses a catalogue code", reports)
				}
				if c.checks.failure == nil || !c.checks.failure(e.Code, data) {
					bad = "failure uses an undeclared or malformed catalogue code"
				}
			}
		}
		for _, p := range data.Entries {
			if slices.Contains(generated.Errors.Reserved, p.Key) {
				bad = "failure uses a reserved Data key"
			}
		}
		if c.op.Errors != nil {
			found := false
			for _, d := range c.op.Errors {
				if d.Code == e.Code {
					found = true
				}
			}
			if !found {
				bad = "failure is outside the declared codes"
			}
		}
		if bad != "" {
			return g.crossingHostError(c, bad, reports)
		}
		if !c.payConversion(data, 0) {
			return corevalue.Value{}, nil
		}
		failed := append(result.failed, c.named()...)
		v, _ := corevalue.NewMap(failed)
		return corevalue.Value{}, &v
	}
	if c.ignoreResult {
		return corevalue.Value{}, nil
	}
	if !c.payConversion(result.value, c.lateFuel) {
		return corevalue.Value{}, nil
	}
	return result.value, nil
}
