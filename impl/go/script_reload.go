package northtalk

import (
	"fmt"
	"slices"
	"strings"

	"github.com/odogono/odgn-talk/impl/go/internal/check"
	"github.com/odogono/odgn-talk/impl/go/internal/machine"
	"github.com/odogono/odgn-talk/impl/go/internal/shape"
	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
)

type CarryOver int

const (
	ResetVariables CarryOver = iota
	CarryVariables
)

type Stop struct {
	Script          string
	Reason          string
	DiscardedRuns   []RunID
	DroppedMessages []DeliveryID
	PendingCalls    []CallID
}

func (*Stop) isReport() {}

// Reload validates and checks carried state before terminating old Runs and
// rolling back their participants. Library replacement is not supported yet.
func (s *Script) Reload(source string, carry CarryOver) ([]Report, error) {
	g := s.group
	exports, importIDs, states, calls := libraryOptions(g.libraries)
	fields := map[string]string{"source": corevalue.DisplayText(source), "carry": "no", "identity": fmt.Sprintf("%x", codeIdentity("script", s.name, source, importIDs))}
	if carry == CarryVariables {
		fields["carry"] = "yes"
	}
	if e := g.beginWorker(); e != nil {
		g.recordRefusal("reload", []string{s.name}, fields, ReentrantCall)
		return nil, e
	}
	defer g.endWorker()
	g.record("reload", true, []string{s.name}, fields)
	if g.effectUnknown {
		return nil, g.refuse(EffectStateUnknown, "Group has unresolved external effects")
	}
	if carry != ResetVariables && carry != CarryVariables {
		return nil, g.refuse(InvalidValue, "invalid carry policy")
	}
	declarations := map[string]map[string]check.OperationCheck{}
	for name, grant := range s.grants {
		if grant.revoked && !grant.disabled {
			continue
		}
		declarations[name] = map[string]check.OperationCheck{}
		for opName, kept := range grant.operations {
			if !kept {
				continue
			}
			op := grant.definition.ops[opName]
			args := make([]shape.Shape, len(op.Args))
			for n, arg := range op.Args {
				args[n] = arg.inner
			}
			declarations[name][opName] = check.OperationCheck{Mode: modeName(op.Mode), Args: args}
		}
	}
	objects := make([]string, 0, len(s.state.Objects))
	for name := range s.state.Objects {
		objects = append(objects, name)
	}
	unit, loadError := g.core.compile(s.name, source, check.Options{Imports: exports, ImportCalls: calls, Objects: objects, ObjectProperties: objectProperties(s.state.Objects), OwnerProperties: ownerProperties(s.owner), PatternSize: s.limits.PatternSize, Grants: declarations}, importIDs)
	if loadError != nil {
		g.diagnostics(loadError)
		return nil, loadError
	}
	state, e := machine.InitializeLinkedBound(unit, g, states, s.state.Me, s.state.Objects)
	if e != nil {
		pos := e.(*machine.InitError).Instruction.Pos
		loadError = &LoadError{[]Diagnostic{{Code: "initialiser failed", Unit: s.name, Line: pos.Line, Col: pos.Column}}}
		g.diagnostics(loadError)
		return nil, loadError
	}
	if carry == CarryVariables {
		old := s.state.Variables
		if s.active != nil {
			old = s.active.run.Base
		}
		for n, name := range state.Unit.Variables {
			if j := slices.Index(s.state.Unit.Variables, name); j >= 0 {
				state.Variables[n] = old[j]
			}
		}
		var size int64
		for _, v := range state.Variables {
			size += machine.Size(v)
		}
		if size > s.limits.PersistentState {
			return nil, g.refuse(HostErrorCode("state too large"), "carried Script Variables exceed Persistent State")
		}
	}
	stop := &Stop{Script: s.name, Reason: "reload"}
	var reports []Report
	for _, x := range s.runs {
		g.abandonScopes(s, x, &reports)
		g.rollbackParticipant(s, x, &reports)
		if g.effectUnknown {
			var settlements []func()
			g.stopEffectGroup(&reports, &settlements, func(d delivery, run RunID, _ Verdict, _ Value, _ Outcome) {
				reports = append(reports, g.settleReloadDelivery(d.script, d, run)...)
			})
			for _, settle := range settlements {
				settle()
			}
			return reports, &HostError{EffectStateUnknown, "Reload participant rollback failed"}
		}
	}
	queue, runs := s.queue, s.runs
	s.queue = nil
	s.runs = nil
	s.active = nil
	for _, x := range runs {
		stop.DiscardedRuns = append(stop.DiscardedRuns, x.id)
		// Keep the same call order as the machine, including Script replies.
		if x.waitCall != "" {
			stop.PendingCalls = append(stop.PendingCalls, x.waitCall)
		}
		if j := x.run.Join; j != nil && !j.Ready {
			for _, m := range j.Members {
				if m.Reply == nil {
					stop.PendingCalls = append(stop.PendingCalls, CallID(m.ID))
				}
			}
		}
		for _, id := range x.run.Abandons {
			stop.PendingCalls = append(stop.PendingCalls, CallID(id))
		}
		if x.abandonCall != "" {
			stop.PendingCalls = append(stop.PendingCalls, x.abandonCall)
		}
		g.discardOperationCalls(x)

	}
	for _, item := range queue {
		if item.run != nil {
			continue
		}
		d := item.delivery
		g.release(s)
		if d.id != "" {
			stop.DroppedMessages = append(stop.DroppedMessages, d.id)
		}

	}
	stopFields := map[string]string{"reason": "\"reload\""}
	ids := func(xs []string) string { return "[" + strings.Join(xs, ", ") + "]" }
	if len(stop.DiscardedRuns) > 0 {
		xs := []string{}
		for _, id := range stop.DiscardedRuns {
			xs = append(xs, string(id))
		}
		stopFields["discarded"] = ids(xs)
	}
	if len(stop.DroppedMessages) > 0 {
		xs := []string{}
		for _, id := range stop.DroppedMessages {
			xs = append(xs, string(id))
		}
		stopFields["dropped"] = ids(xs)
	}
	if len(stop.PendingCalls) > 0 {
		xs := []string{}
		for _, id := range stop.PendingCalls {
			xs = append(xs, string(id))
		}
		stopFields["abandoned"] = ids(xs)
	}
	g.record("stopped", false, []string{s.name}, stopFields)
	reports = append(reports, stop)
	for _, x := range runs {
		reports = append(reports, g.settleReloadDelivery(s, x.delivery, x.id)...)
	}
	for _, item := range queue {
		if item.run == nil {
			reports = append(reports, g.settleReloadDelivery(s, item.delivery, "")...)
		}
	}
	s.state.Gone = true
	state.ScriptNames = slices.Clone(s.state.ScriptNames)
	s.state = state
	g.mu.Lock()
	s.stopped = false
	s.stopReason = ""
	g.mu.Unlock()
	for name, grant := range s.grants {
		if grant.revoked && !grant.disabled {
			delete(s.grants, name)
		}
	}
	return reports, nil
}

func (g *Group) settleReloadDelivery(s *Script, d delivery, run RunID) []Report {
	g.reply(d.reply, corevalue.Value{}, "stopped", corevalue.Value{})
	if p := d.pending; p != nil {
		p.settle(Nothing, sendFailure("stopped", nil))
	}
	if decision := d.decision; decision != nil {
		report := &Decided{Delivery: d.id, Verdict: Undecided, Undecided: []UndecidedBy{{Script: s.name, Run: run, Outcome: Cancelled}}}
		report = decision.sealReport(report)
		if report != nil {
			g.recordDecided(report)
			decision.finish()
			return []Report{report}
		}
	}
	return nil
}
