package northtalk

import (
	"fmt"
	"slices"

	"github.com/odogono/odgn-talk/impl/go/internal/machine"
	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
)

type segmentParticipant struct {
	name  string
	grant *Grant
}

func invokeEffect(hook func(SegmentContext) EffectResult, ctx SegmentContext) (result EffectResult) {
	defer func() {
		if caught := recover(); caught != nil {
			result = EffectResult{EffectUnknown, fmt.Sprintf("Host panic: %v", caught)}
		}
	}()
	result = hook(ctx)
	if result.Status != EffectOK && result.Status != EffectFailed && result.Status != EffectUnknown {
		result = EffectResult{EffectUnknown, "invalid lifecycle result"}
	}
	return
}

func (g *Group) effectHook(s *Script, x *execution, p *segmentParticipant, phase string, reports *[]Report) *EffectFailure {
	lifecycle := p.grant.definition.lifecycle
	hook := lifecycle.Begin
	if phase == "commit" {
		hook = lifecycle.Commit
	} else if phase == "rollback" {
		hook = lifecycle.Rollback
	}
	ctx := SegmentContext{Group: g, ScriptName: s.name, RunID: x.id, GrantName: p.name, SegmentID: fmt.Sprintf("%s.s%d", x.id, x.segment), Binding: p.grant.binding, Now: g.clock}
	result := invokeEffect(hook, ctx)
	g.record("effect", false, []string{ctx.SegmentID}, map[string]string{"grant": p.name, "phase": phase, "status": string(result.Status)})
	if result.Status == EffectOK {
		return nil
	}
	failure := &EffectFailure{Script: s.name, Run: x.id, Grant: p.name, Segment: ctx.SegmentID, Phase: phase, Status: result.Status, Detail: result.Detail}
	*reports = append(*reports, failure)
	g.record("effect-failure", false, []string{string(x.id)}, map[string]string{"grant": p.name, "segment": ctx.SegmentID, "phase": phase, "status": string(result.Status)})
	return failure
}

func (g *Group) enrollParticipant(s *Script, x *execution, name string, grant *Grant, reports *[]Report) *EffectFailure {
	p := &segmentParticipant{name, grant}
	failure := g.effectHook(s, x, p, "begin", reports)
	if failure == nil || failure.Status == EffectUnknown {
		x.participant = p
	}
	if failure != nil && failure.Status == EffectUnknown {
		g.markEffectUnknown(x)
	}
	return failure
}

func (g *Group) markEffectUnknown(x *execution) {
	g.effectUnknown = true
	reason := string(EffectStateUnknown)
	x.stopReason = &reason
	x.run.Status = machine.Stopped
}

// Clear enrollment before rollback so even a failed hook is attempted once.
func (g *Group) rollbackParticipant(s *Script, x *execution, reports *[]Report) {
	if p := x.participant; p != nil {
		x.participant = nil
		if g.effectHook(s, x, p, "rollback", reports) != nil {
			g.markEffectUnknown(x)
		}
	}
}

// Scope abandonment precedes finalization. Only abandonment on the
// participating Grant prevents commit; unrelated release failures disable
// their Grant without changing this participant's decision.
func (g *Group) finalizeParticipant(s *Script, x *execution, reports *[]Report) {
	failure := g.abandonScopes(s, x, reports)
	p := x.participant
	if p == nil {
		return
	}
	r := x.run
	rollback := r.Status == machine.Faulted || r.Status == machine.Stopped || r.Cancelling && r.CancelLimit != ""
	if !rollback && failure == nil {
		failure = g.effectHook(s, x, p, "commit", reports)
		if failure == nil {
			x.participant = nil
			return
		}
	}
	if !rollback {
		x.effect = failure
		s.state.Variables = slices.Clone(r.Base)
		if failure.Status == EffectUnknown && failure.Phase != "abandon" {
			g.markEffectUnknown(x)
		} else {
			r.Status = machine.Completed
			r.Result = corevalue.Value{}
			r.Passed, r.Vetoed = false, false
		}
		g.abandonSend(x)
		r.AbandonJoin()
		g.discardOperationCalls(x)
	}
	g.rollbackParticipant(s, x, reports)
	if x.effect != nil {
		g.writeAbandon(x)
	}
}

func effectDisplay(e *EffectFailure) string {
	fields := []corevalue.Pair{{Key: "grant", Val: mustText(e.Grant)}, {Key: "segment", Val: mustText(e.Segment)}, {Key: "phase", Val: mustText(e.Phase)}, {Key: "status", Val: mustText(string(e.Status))}}
	if e.Scope != "" {
		fields = append(fields, corevalue.Pair{Key: "scope", Val: mustText(e.Scope)})
	}
	v, _ := corevalue.NewMap(fields)
	return v.Display()
}

func (g *Group) stopEffectGroup(reports *[]Report, settlements *[]func(), seal func(delivery, RunID, Verdict, Value, Outcome)) {
	for _, s := range g.scripts {
		g.terminateScript(s, string(EffectStateUnknown), reports, settlements, seal)
	}
}
