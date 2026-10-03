package northtalk

import (
	"fmt"
	"github.com/odogono/odgn-talk/impl/go/internal/machine"
	coretrace "github.com/odogono/odgn-talk/impl/go/internal/trace"
	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
	"strings"
)

func (r *Unhandled) isReport() {}

func (g *Group) release(s *Script) { g.mu.Lock(); s.reserved--; g.mu.Unlock() }
func (s *Script) start(d delivery) {
	s.counters.Runs++
	args := make([]corevalue.Value, len(d.message.Args))
	for j, v := range d.message.Args {
		args[j] = v.inner
	}
	fuel, alloc := s.limits.FuelPerRun, s.limits.AllocPerRun
	if o := d.message.Limits; o != nil {
		if o.FuelPerRun > 0 {
			fuel = o.FuelPerRun
		}
		if o.AllocPerRun > 0 {
			alloc = o.AllocPerRun
		}
	}
	r := machine.StartDelivery(s.state, d.message.Name, args, machine.Limits{Fuel: fuel, Alloc: alloc, Persistent: s.limits.PersistentState, Depth: s.limits.CallDepth, Pattern: s.limits.PatternSize})
	if d.during != nil {
		r.SetDuring(*d.during)
	}
	handler := ""
	if s.hasHandler(d.message.Name) {
		handler = d.message.Name
	}
	s.active = &execution{run: r, delivery: d, id: RunID(fmt.Sprintf("%s/r%d", s.name, s.counters.Runs)), handler: handler, clause: r.Clause, how: "start"}
}
func (s *Script) persistentWithoutRun() int64 {
	var size int64
	for _, v := range s.state.Variables {
		size += machine.Size(v)
	}
	return size + s.mailboxSize()
}
func (s *Script) mailboxSize() int64 {
	var size int64
	for _, d := range s.mailbox {
		size += 32
		for _, v := range d.message.Args {
			size += machine.Size(v.inner)
		}
	}
	return size
}
func (s *Script) persistent() int64 {
	size := s.persistentWithoutRun()
	if s.active != nil {
		size += s.active.run.RetainedSize()
	}
	return size
}

func (g *Group) runPump(o PumpOptions, inputs []delivery) (PumpResult, error) {
	result := PumpResult{State: Idle}
	used := map[*Script]int64{}
	budget := map[*Script]int64{}
	skipped := map[*Script]bool{}
	var settlements []func()
	defer func() {
		for _, settle := range settlements {
			settle()
		}
	}()
	for _, s := range g.scripts {
		if o.FuelSlice > 0 {
			budget[s] = max(0, o.FuelSlice-s.debt)
			s.debt = max(0, s.debt-o.FuelSlice)
		}
	}
	// All inputs are drained before the first turn. Cancellation acts on the
	// resulting mailbox, or marks a retained Run for cleanup in its own turn.
	for _, d := range inputs {
		if d.cancel == "" {
			continue
		}
		s := d.script
		found := false
		for j, q := range s.mailbox {
			if q.id == d.cancel {
				s.mailbox = append(s.mailbox[:j], s.mailbox[j+1:]...)
				g.release(s)
				report := &RunEnd{Script: s.name, Delivery: q.id, Outcome: Cancelled}
				result.Reports = append(result.Reports, report)
				g.record("run", false, nil, map[string]string{"outcome": "cancelled", "delivery": string(q.id), "fuel": "0", "alloc": "0"})
				settlements = append(settlements, func() { q.pending.settle(Nothing, sendFailure("cancelled", nil)) })
				found = true
				break
			}
		}
		if !found && s.active != nil && s.active.delivery.id == d.cancel {
			s.active.run.Cancel(s.limits.CleanupBudget)
		}
	}
	for {
		progress := false
		for _, s := range g.scripts {
			if skipped[s] || s.active == nil && len(s.mailbox) == 0 {
				continue
			}
			if o.FuelSlice > 0 && used[s] >= budget[s] {
				skipped[s] = true
				result.State = Sliced
				continue
			}
			if o.FuelCap > 0 && result.FuelUsed >= o.FuelCap {
				result.State = Sliced
				break
			}
			if s.active == nil {
				d := s.mailbox[0]
				s.mailbox = s.mailbox[1:]
				g.release(s)
				// With no error clauses there is no dispatch code to run. A
				// future wait-for observer will still see the message here.
				if d.during != nil && !s.hasHandler("error") {
					progress = true
					continue
				}
				s.start(d)
			}
			x := s.active
			r := x.run
			if r.Status == machine.Blocked {
				skipped[s] = true
				continue
			}
			progress = true
			fuel, alloc, raised := r.Fuel, r.Alloc, len(r.Raises)
			slice := int64(0)
			by := "slice"
			if o.FuelSlice > 0 {
				slice = budget[s] - used[s]
			}
			if o.FuelCap > 0 && (slice == 0 || o.FuelCap-result.FuelUsed < slice) {
				slice = o.FuelCap - result.FuelUsed
				by = "cap"
			}
			r.PersistentBase = s.mailboxSize()
			r.Execute(slice)
			delta := r.Fuel - fuel
			used[s] += delta
			result.FuelUsed += delta
			s.counters.FuelTotal += delta
			s.counters.AllocTotal += r.Alloc - alloc
			for _, raise := range r.Raises[raised:] {
				fields := map[string]string{"at": fmt.Sprintf("%s:%d", s.name, raise.PC), "pos": fmt.Sprintf("%d:%d", raise.Instruction.Pos.Line, raise.Instruction.Pos.Column)}
				name := "raise"
				if raise.Guard {
					name = "guard-skip"
				}
				if raise.Value != nil {
					fields["value"] = coretrace.Display(*raise.Value)
				} else {
					fields["code"] = corevalue.DisplayText(raise.Code)
				}
				g.record(name, false, []string{string(x.id)}, fields)
			}
			common := map[string]string{"fuel": fmt.Sprint(delta), "alloc": fmt.Sprint(r.Alloc - alloc)}
			if x.how == "start" {
				if x.delivery.id != "" {
					common["delivery"] = string(x.delivery.id)
				}
				if x.delivery.from != "" {
					common["from"] = string(x.delivery.from)
				}
				if x.handler != "" {
					common["handler"] = x.handler
				}
				if r.Clause > 0 {
					common["clause"] = fmt.Sprint(r.Clause)
				}
			}
			if r.Status == machine.Preempted {
				common["by"] = by
				g.record("preempt", false, []string{string(x.id), x.how}, common)
				x.how = "continue"
				skipped[s] = true
				result.State = Sliced
				continue
			}
			if r.Status == machine.Blocked {
				skipped[s] = true
				continue
			}
			report := g.finish(s, x, common)
			result.Reports = append(result.Reports, report)
			if report.Outcome == Errored && x.delivery.message.Name != "error" {
				g.queueError(s, x)
			}
			if report.Outcome == UnhandledOutcome && x.delivery.during == nil {
				unhandled := &Unhandled{Delivery: x.delivery.id, Message: x.delivery.message}
				result.Reports = append(result.Reports, unhandled)
				fields := map[string]string{"message": x.delivery.message.Name}
				if len(x.delivery.message.Args) > 0 {
					fields["args"] = argsDisplay(x.delivery.message.Args)
				}
				g.record("unhandled", false, []string{string(x.delivery.id)}, fields)
			}
			if p := x.delivery.pending; p != nil {
				settlements = append(settlements, func() {
					if report.Outcome == Completed {
						p.settle(report.Result, nil)
					} else {
						reason := map[Outcome]string{Errored: "errored", LimitFault: "limit fault", Cancelled: "cancelled", UnhandledOutcome: "unhandled"}[report.Outcome]
						p.settle(Nothing, sendFailure(reason, report.Error))
					}
				})
			}
			s.active = nil
		}
		if !progress || o.FuelCap > 0 && result.FuelUsed >= o.FuelCap {
			break
		}
	}
	if o.FuelSlice > 0 {
		for _, s := range g.scripts {
			s.debt += max(0, used[s]-budget[s])
		}
	}
	// Exhausting a budget matters only when some runnable work remains.
	result.State = Idle
	for _, s := range g.scripts {
		if s.active != nil && s.active.run.Status != machine.Blocked || len(s.mailbox) > 0 && s.active == nil {
			result.State = Sliced
		}
	}
	g.record("pumped", false, nil, map[string]string{"state": []string{"idle", "sliced", "stopped"}[result.State], "fuel": fmt.Sprint(result.FuelUsed)})
	return result, nil
}

func (s *Script) hasHandler(name string) bool {
	for _, b := range s.state.Unit.Bodies {
		if b.Checked.Kind == "handler" && b.Checked.Name == name {
			return true
		}
	}
	return false
}

// Error delivery is a new mailbox message, after the failed Run's records.
// Reserve against both waiting messages and Host inputs accepted during Pump.
// There is no Host Delivery id and no instruction or allocation charge.
func (g *Group) queueError(s *Script, x *execution) {
	g.mu.Lock()
	full := s.reserved >= s.limits.MailboxDepth
	if !full {
		s.reserved++
	}
	g.mu.Unlock()
	if full {
		g.record("note", false, []string{string(x.id)}, map[string]string{"kind": "error-dropped"})
		return
	}
	args := make([]corevalue.Value, len(x.delivery.message.Args))
	for j, v := range x.delivery.message.Args {
		args[j] = v.inner
	}
	during, _ := corevalue.NewMap([]corevalue.Pair{
		{Key: "name", Val: mustText(x.delivery.message.Name)},
		{Key: "args", Val: corevalue.NewList(args)},
	})
	s.mailbox = append(s.mailbox, delivery{
		script: s, message: Message{Name: "error", Args: []Value{{x.run.Error}}},
		from: x.id, during: &during,
	})
}
func argsDisplay(args []Value) string {
	vs := make([]corevalue.Value, len(args))
	for j, v := range args {
		vs[j] = v.inner
	}
	return coretrace.Display(corevalue.NewList(vs))
}
func sendFailure(reason string, e *ScriptError) *ScriptError {
	fields := []Pair{KV("reason", Value{mustText(reason)})}
	if e != nil {
		vs := []corevalue.Pair{{Key: "code", Val: mustText(e.Code)}, {Key: "message", Val: mustText(e.Message)}}
		for _, p := range e.Data.inner.Entries {
			vs = append(vs, p)
		}
		errorMap, _ := corevalue.NewMap(vs)
		fields = append(fields, KV("error", Value{errorMap}))
	}
	data, _ := Map(fields...)
	return &ScriptError{Code: "send failed", Data: data}
}
func mustText(s string) corevalue.Value { v, _ := corevalue.NewText(s); return v }
func scriptError(v corevalue.Value) *ScriptError {
	var fields []corevalue.Pair
	for _, p := range v.Entries {
		if p.Key != "code" && p.Key != "message" {
			fields = append(fields, p)
		}
	}
	data, _ := corevalue.NewMap(fields)
	return &ScriptError{Code: v.Get("code").Text, Message: v.Get("message").Text, Data: Value{data}}
}
func (g *Group) finish(s *Script, x *execution, common map[string]string) *RunEnd {
	r := x.run
	end, outcome := "return", Completed
	switch r.Status {
	case machine.Errored:
		end, outcome = "error", Errored
	case machine.Faulted:
		end, outcome = "fault", LimitFault
		s.counters.Faults++
		fields := map[string]string{"limit": r.Limit, "at": fmt.Sprintf("%s:%d", s.name, r.PC), "pos": fmt.Sprintf("%d:%d", r.At.Pos.Line, r.At.Pos.Column)}
		if len(r.Rollback) > 0 {
			fields["rollback"] = "[" + strings.Join(r.Rollback, ", ") + "]"
		}
		g.record("fault", false, []string{string(x.id)}, fields)
	case machine.Unhandled:
		end, outcome = "unhandled", UnhandledOutcome
	case machine.Cancelled:
		end, outcome = "cancel", Cancelled
	}
	if outcome == Cancelled && (r.CancelCode != "" || r.CancelLimit != "") {

		fields := map[string]string{}
		if r.CancelCode != "" {
			fields["code"] = corevalue.DisplayText(r.CancelCode)
		}
		if r.CancelLimit != "" {
			fields["limit"] = r.CancelLimit
		}
		g.record("cleanup-failed", false, []string{string(x.id)}, fields)
	}
	common["state"] = fmt.Sprint(s.persistentWithoutRun())
	common["end"] = end
	g.record("seg", false, []string{string(x.id), x.how}, common)
	report := &RunEnd{Script: s.name, Run: x.id, Delivery: x.delivery.id, Handler: x.handler, Outcome: outcome, Result: Value{r.Result}, Fuel: r.Fuel, Alloc: r.Alloc, Limit: ""}
	if outcome == Cancelled && (r.CancelCode != "" || r.CancelLimit != "") {
		report.CleanupFailed = &CleanupFailure{Code: r.CancelCode, Limit: r.CancelLimit}
	}
	outputs := map[string]string{"outcome": []string{"completed", "errored", "limit-fault", "cancelled", "unhandled"}[outcome], "delivery": string(x.delivery.id), "handler": x.handler, "fuel": fmt.Sprint(r.Fuel), "alloc": fmt.Sprint(r.Alloc)}
	if x.delivery.id == "" {
		delete(outputs, "delivery")
	}
	if x.handler == "" {
		delete(outputs, "handler")
	}
	if outcome == Completed && r.Result.Kind != corevalue.Nothing {
		outputs["value"] = coretrace.Display(r.Result)
	}
	if outcome == Errored {
		report.Error = scriptError(r.Error)
		outputs["error"] = coretrace.Display(r.Error)
	}
	if outcome == LimitFault {
		outputs["limit"] = r.Limit
		report.Limit = r.Limit
	}
	if outcome == Errored || outcome == LimitFault {
		report.At = Location{Unit: s.name, Handler: x.handler, Line: r.At.Pos.Line, Col: r.At.Pos.Column, PC: r.PC}
		if outcome == LimitFault && len(r.Frames) > 0 {
			report.At.Handler = r.State.Unit.Bodies[r.Frames[len(r.Frames)-1].Body].Checked.Name
		}
		if outcome == Errored {
			for j := len(r.Raises) - 1; j >= 0; j-- {
				a := r.Raises[j]
				if !a.Guard {
					report.At = Location{Unit: s.name, Handler: a.Handler, Line: a.Instruction.Pos.Line, Col: a.Instruction.Pos.Column, PC: a.PC}
					break
				}
			}
		}
	}

	g.record("run", false, []string{string(x.id)}, outputs)
	return report
}
