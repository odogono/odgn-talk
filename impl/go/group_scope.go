package northtalk

import (
	"context"
	"fmt"
	"slices"

	"github.com/odogono/odgn-talk/impl/go/internal/machine"
	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
)

type scopeSlot struct {
	grantName, name, abandon string
	grant                    *Grant
}

func (*EffectFailure) isReport() {}

func (x *execution) scopeIndex(grant, name string) int {
	return slices.IndexFunc(x.scopes, func(s scopeSlot) bool { return s.grantName == grant && s.name == name })
}

func (x *execution) acknowledgeScope(grantName string, grant *Grant, op Operation) string {
	if op.Scope == nil {
		return ""
	}
	s := op.Scope
	action := "opened"
	if s.Opens != "" {
		x.scopes = append(x.scopes, scopeSlot{grantName, s.Opens, s.Abandon, grant})
	} else {
		i := x.scopeIndex(grantName, s.Closes)
		x.scopes = slices.Delete(x.scopes, i, i+1)
		action = "closed"
	}
	x.updateOpenScope()
	return action
}

func (x *execution) updateOpenScope() {
	x.run.OpenScope = nil
	if len(x.scopes) > 0 {
		s := x.scopes[len(x.scopes)-1]
		x.run.OpenScope = &machine.Scope{Grant: s.grantName, Name: s.name}
	}
}

// Automatic calls use the saved implementation and binding, irrespective of
// revocation or disablement. They finish before any Run outcome is published.
func (g *Group) abandonScopes(s *Script, x *execution, reports *[]Report) *EffectFailure {
	return g.abandonGrantScopes(s, x, nil, reports)
}

// abandonGrantScopes abandons the scopes of the Grants p enrolls, or every
// scope when p is nil.
func (g *Group) abandonGrantScopes(s *Script, x *execution, p *segmentParticipant, reports *[]Report) *EffectFailure {
	var participatingFailure *EffectFailure
	for i := len(x.scopes) - 1; i >= 0; i-- {
		slot := x.scopes[i]
		if p != nil && !p.enrolled(slot.grantName) {
			continue
		}
		x.scopes = slices.Delete(x.scopes, i, i+1)
		x.updateOpenScope()
		op := slot.grant.definition.ops[slot.abandon]
		x.calls++
		call := &Call{group: g, scriptName: s.name, runID: x.id, grantName: slot.grantName, binding: slot.grant.binding, id: CallID(fmt.Sprintf("%s.c%d", x.id, x.calls)), segmentID: fmt.Sprintf("%s.s%d", x.id, x.segment), now: g.clock, context: context.Background(), starting: true, scopeName: slot.name, automatic: true}
		v, err := invokeOperation(op, call, nil)
		call.finish()
		if call.invalidAutomatic {
			err = &HostError{InvalidValue, "automatic abandonment attempted a budget or settlement call"}
		}
		fields := map[string]string{"op": slot.grantName + "." + slot.abandon, "args": "[]", "automatic": "yes"}
		_, failure, _ := g.completeOperation(s, x, slot.grantName, slot.abandon, op, call, nil, v, err, fields, func() {
			g.record("call", false, []string{string(call.id)}, fields)
		}, 0, reports, x.run.Cancelling)
		action := "abandoned"
		if failure != nil {
			action = "failed"
		}
		g.record("scope", false, []string{string(call.id)}, map[string]string{"grant": slot.grantName, "name": slot.name, "action": action})
		if failure != nil {
			slot.grant.disabled = true
			status := EffectStatus("failed")
			detail := fmt.Sprint(err)
			if failure.Get("code").Text == "host error" {
				status = "unknown"
				detail = call.failureDetail
			}
			report := &EffectFailure{Script: s.name, Run: x.id, Grant: slot.grantName, Segment: call.segmentID, Phase: "abandon", Status: status, Scope: slot.name, Detail: detail}
			if x.participant != nil && x.participant.enrolled(slot.grantName) && participatingFailure == nil {
				participatingFailure = report
			}
			*reports = append(*reports, report)
			g.record("effect-failure", false, []string{string(x.id)}, map[string]string{"grant": slot.grantName, "segment": call.segmentID, "phase": "abandon", "status": string(status), "scope": slot.name})
		}
	}
	return participatingFailure
}

func scopeError(code, grant, operation, name string) corevalue.Value {
	return operationError(code, []corevalue.Pair{{Key: "capability", Val: mustText(grant)}, {Key: "operation", Val: mustText(operation)}, {Key: "scope", Val: mustText(name)}})
}
