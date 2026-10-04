package northtalk

import (
	"fmt"
	"math/big"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/odogono/odgn-talk/impl/go/internal/machine"
	coretrace "github.com/odogono/odgn-talk/impl/go/internal/trace"
	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
)

func (r *Unhandled) isReport() {}

func (g *Group) release(s *Script) { g.mu.Lock(); s.reserved--; g.mu.Unlock() }
func (s *Script) start(d delivery) {
	s.counters.Runs++
	args := make([]corevalue.Value, len(d.message.Args))
	for j, v := range d.message.Args {
		args[j] = v.inner
	}
	fuel, alloc, width := s.limits.FuelPerRun, s.limits.AllocPerRun, s.limits.MaxJoin
	if o := d.message.Limits; o != nil {
		if o.MaxJoin > 0 {
			width = o.MaxJoin
		}
		if o.FuelPerRun > 0 {
			fuel = o.FuelPerRun
		}
		if o.AllocPerRun > 0 {
			alloc = o.AllocPerRun
		}
	}
	r := machine.StartDelivery(s.state, d.message.Name, args, machine.Limits{Fuel: fuel, Alloc: alloc, Persistent: s.limits.PersistentState, Depth: s.limits.CallDepth, Pattern: s.limits.PatternSize, Join: width})
	if d.during != nil {
		r.SetDuring(*d.during)
	}
	handler := ""
	if s.hasHandler(d.message.Name) {
		handler = d.message.Name
	}
	s.active = &execution{run: r, delivery: d, id: RunID(fmt.Sprintf("%s/r%d", s.name, s.counters.Runs)), handler: handler, clause: -1, how: "start"}
	s.runs = append(s.runs, s.active)
}
func (s *Script) persistentWithoutRun(exclude *execution) int64 {
	var size int64
	for _, v := range s.state.Variables {
		size += machine.Size(v)
	}
	return size + s.retainedOutside(exclude)
}
func (s *Script) mailboxSize() int64 {
	var size int64
	for _, item := range s.queue {
		if item.run != nil {
			continue
		}
		d := item.delivery
		size += 32
		for _, v := range d.message.Args {
			size += machine.Size(v.inner)
		}
	}
	return size
}
func (s *Script) persistent() int64 { return s.persistentWithoutRun(nil) }

func clockNanos(t time.Time) *big.Int {
	ns := new(big.Int).Mul(big.NewInt(t.Unix()), big.NewInt(1e9))
	return ns.Add(ns, big.NewInt(int64(t.Nanosecond())))
}
func deadlineTime(ns *big.Int) time.Time {
	sec, nano := new(big.Int), new(big.Int)
	sec.DivMod(ns, big.NewInt(1e9), nano)
	return time.Unix(sec.Int64(), nano.Int64()).UTC()
}
func (g *Group) fireTimers() {
	type timer struct {
		s *Script
		x *execution
	}
	var due []timer
	now := clockNanos(g.clock)
	for _, s := range g.scripts {
		for _, x := range s.runs {
			if x.deadline != nil && x.deadline.Cmp(now) <= 0 {
				due = append(due, timer{s, x})
			}
		}
	}
	sort.Slice(due, func(i, j int) bool {
		a, b := due[i].x, due[j].x
		if cmp := a.deadline.Cmp(b.deadline); cmp != 0 {
			return cmp < 0
		}
		return a.timerOrder < b.timerOrder
	})
	for _, t := range due {
		if t.x.run.EventWait != nil {
			t.x.run.TimeoutEvent()
		}
		if j := t.x.run.Join; j != nil && j.Waiting && !j.Ready {
			for _, m := range j.Members {
				if m.Reply == nil {
					t.x.run.SettleJoin(m.ID, machine.SendResume{Timeout: true, AfterMS: int64(t.x.maxWait() / time.Millisecond)})
					break
				}
			}
		}
		if t.x.run.SendWait {
			g.abandonSend(t.x)
			t.x.run.SettleSend(machine.SendResume{Timeout: true, AfterMS: int64(t.x.maxWait() / time.Millisecond)})
		}
		t.x.deadline = nil
		t.x.how = "resume"
		t.s.queue = append(t.s.queue, workItem{run: t.x})
	}
}

func (g *Group) runPump(o PumpOptions, inputs []delivery) (PumpResult, error) {
	result := PumpResult{State: Idle}
	used := map[*Script]int64{}
	budget := map[*Script]int64{}
	skipped := map[*Script]bool{}
	var settlements []func()
	seal := func(d delivery, run RunID, verdict Verdict, reason Value, outcome Outcome) {
		if d.decision == nil {
			return
		}
		report := &Decided{Delivery: d.id, Verdict: verdict}
		if verdict == Vetoed {
			report.Vetoes = []Veto{{Script: d.script.name, Run: run, Reason: reason}}
		}
		if verdict == Undecided {
			report.Undecided = []UndecidedBy{{Script: d.script.name, Run: run, Outcome: outcome}}
		}
		if !d.decision.seal(report) {
			return
		}
		result.Reports = append(result.Reports, report)
		g.recordDecided(report)
		settlements = append(settlements, d.decision.finish)
	}
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
	// Drain inputs in order before timers and turns. Cancellation either
	// removes a message or queues a suspended Run's cleanup at this position.
	for _, d := range inputs {
		if d.cancel == "" {
			d.script.queue = append(d.script.queue, workItem{delivery: d})
			continue
		}
		s := d.script
		found := false
		for j, item := range s.queue {
			q := item.delivery
			if item.run == nil && q.id == d.cancel {
				s.queue = slices.Delete(s.queue, j, j+1)
				g.release(s)
				report := &RunEnd{Script: s.name, Delivery: q.id, Outcome: Cancelled}
				result.Reports = append(result.Reports, report)
				g.record("run", false, nil, map[string]string{"outcome": "cancelled", "delivery": string(q.id), "fuel": "0", "alloc": "0"})
				if q.pending != nil {
					settlements = append(settlements, func() { q.pending.settle(Nothing, sendFailure("cancelled", nil)) })
				}
				seal(q, "", Undecided, Nothing, Cancelled)
				found = true
				break
			}
		}
		if !found {
			for _, x := range s.runs {
				if x.delivery.id == d.cancel {
					g.cancelExecution(s, x)
					break
				}
			}
		}
	}
	// Only timers retained from an earlier Pump fire, after Host inputs.
	g.fireTimers()

	for {
		progress := false
		for _, s := range g.scripts {
			if skipped[s] || s.active == nil && len(s.queue) == 0 {
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
			observationSpent := false
			if s.active == nil {
				item := s.queue[0]
				s.queue[0] = workItem{}
				s.queue = s.queue[1:]
				if item.run != nil {
					s.active = item.run
					s.active.run.Resume()
				} else {
					d := item.delivery
					g.release(s)
					fuel, alloc := g.observe(s, d, func() { seal(d, "", Allowed, Nothing, Completed) })
					used[s] += fuel
					result.FuelUsed += fuel
					s.counters.FuelTotal += fuel
					s.counters.AllocTotal += alloc
					observationSpent = o.FuelSlice > 0 && used[s] >= budget[s] || o.FuelCap > 0 && result.FuelUsed >= o.FuelCap
					if d.during != nil && !s.hasHandler("error") {
						progress = true
						continue
					}
					s.start(d)
					if observationSpent && s.active.run.Status == machine.Running {
						s.active.run.Status = machine.Preempted
					}
				}
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
			for {
				if observationSpent {
					break
				}
				r.PersistentBase = s.retainedOutside(x)
				r.ClockNS = clockNanos(g.clock)
				if r.SendResume != nil || r.Join != nil && r.Join.Ready {
					r.ResumeSend()
					r.ResumeJoin()
					g.writeRaises(x, raised)
					raised = len(r.Raises)
				}
				remaining := slice
				if slice > 0 {
					remaining -= r.Fuel - fuel
					if remaining <= 0 && r.Status == machine.Running {
						r.Status = machine.Preempted
						break
					}
				}
				r.ExecuteSelected(remaining, func() {
					if machine.QueuePolicy(s.state.Unit.Bodies[x.clause]) == "replacing" {
						g.replaceEarlier(s, x)
						r.PersistentBase = s.retainedOutside(x)
					}
					if !x.deciding {
						seal(x.delivery, x.id, Allowed, Nothing, Completed)
					}
				}, func(to, message string, args []corevalue.Value, wait bool) bool {
					ok := g.send(x, to, message, args, wait)
					if ok {
						r.PersistentBase = s.retainedOutside(x)
					}
					return ok
				})
				if r.Status != machine.Dispatching {
					break
				}
				g.writeRaises(x, raised)
				raised = len(r.Raises)
				g.selectClause(s, x, func() { seal(x.delivery, x.id, Allowed, Nothing, Completed) })
				if r.Status != machine.Running {
					break
				}
			}
			delta := r.Fuel - fuel
			used[s] += delta
			result.FuelUsed += delta
			s.counters.FuelTotal += delta
			s.counters.AllocTotal += r.Alloc - alloc
			g.writeRaises(x, raised)
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
				g.writeAbandon(x)
				x.how = "continue"
				skipped[s] = true
				result.State = Sliced
				continue
			}
			if r.Status == machine.Blocked {
				skipped[s] = true
				continue
			}
			if r.Status == machine.Parked {
				x.parked = true
				common["state"], common["end"] = fmt.Sprint(s.persistent()), "park"
				g.record("seg", false, []string{string(x.id), x.how}, common)
				s.active = nil
				continue
			}
			if r.Status == machine.Suspended {
				g.nextTimer++
				x.timerOrder = g.nextTimer
				if r.EventWait != nil {
					x.deadline = r.EventWait.Deadline
					common["end"] = r.EventWait.Kind
				} else if r.Join != nil {
					common["end"] = "join-end"
					if r.BeginJoinWait() {
						s.queue = append(s.queue, workItem{run: x})
					} else {
						x.deadline = new(big.Int).Add(clockNanos(g.clock), big.NewInt(int64(x.maxWait())))
					}
				} else if r.SendWait {
					x.deadline = new(big.Int).Add(clockNanos(g.clock), big.NewInt(int64(x.maxWait())))
					common["end"] = "send-wait"
				} else {
					x.deadline = new(big.Int).Add(clockNanos(g.clock), r.WaitNS)
					common["end"] = "wait"
				}
				common["state"] = fmt.Sprint(s.persistent())
				if x.deadline != nil && !r.SendWait && r.Join == nil {
					common["until"] = deadlineTime(x.deadline).Format(time.RFC3339Nano)
				}
				g.record("seg", false, []string{string(x.id), x.how}, common)
				if r.Join != nil && r.Join.Ready {
					x.how = "resume"
				}
				if x.openVerdict() {
					seal(x.delivery, x.id, Allowed, Nothing, Completed)
				}
				s.active = nil
				continue
			}
			report := g.finish(s, x, common, func() {
				if r.Status == machine.Completed && !r.Passed && x.openVerdict() {
					verdict := Allowed
					if r.Vetoed {
						verdict = Vetoed
					}
					seal(x.delivery, x.id, verdict, Value{r.VetoReason}, Completed)
				}
			})
			result.Reports = append(result.Reports, report)
			reason := map[Outcome]string{Errored: "errored", LimitFault: "limit fault", Cancelled: "cancelled", UnhandledOutcome: "unhandled", Dropped: "dropped"}[report.Outcome]
			if r.Passed {
				reason = "unhandled"
			}
			g.reply(x.delivery.reply, report.Result.inner, reason, r.Error)
			if report.Outcome == Errored && x.delivery.message.Name != "error" {
				g.queueError(s, x)
			}
			if (report.Outcome == UnhandledOutcome || r.Passed) && x.delivery.during == nil {
				unhandled := &Unhandled{Delivery: x.delivery.id, Message: x.delivery.message}
				result.Reports = append(result.Reports, unhandled)
				fields := map[string]string{"message": x.delivery.message.Name}
				if len(x.delivery.message.Args) > 0 {
					fields["args"] = argsDisplay(x.delivery.message.Args)
				}
				var ids []string
				if x.delivery.id != "" {
					ids = []string{string(x.delivery.id)}
				}
				g.record("unhandled", false, ids, fields)
			}
			if report.Outcome == UnhandledOutcome || r.Passed {
				seal(x.delivery, x.id, Allowed, Nothing, UnhandledOutcome)
			} else if report.Outcome != Completed {
				seal(x.delivery, x.id, Undecided, Nothing, report.Outcome)
			}
			if p := x.delivery.pending; p != nil {
				settlements = append(settlements, func() {
					if report.Outcome == Completed && !r.Passed {
						p.settle(report.Result, nil)
					} else {
						reason := map[Outcome]string{Errored: "errored", LimitFault: "limit fault", Cancelled: "cancelled", UnhandledOutcome: "unhandled", Dropped: "dropped"}[report.Outcome]
						if r.Passed {
							reason = "unhandled"
						}
						p.settle(Nothing, sendFailure(reason, report.Error))
					}
				})
			}
			s.active = nil
			for j, live := range s.runs {
				if live == x {
					s.runs = slices.Delete(s.runs, j, j+1)
					s.releaseParked(x.clause)
					break
				}
			}
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
		if s.active != nil && s.active.run.Status != machine.Blocked || len(s.queue) > 0 && s.active == nil {
			result.State = Sliced
		}
	}
	fields := map[string]string{"state": []string{"idle", "sliced", "stopped"}[result.State], "fuel": fmt.Sprint(result.FuelUsed)}
	var next *big.Int
	for _, s := range g.scripts {
		for _, x := range s.runs {
			if x.deadline != nil && (next == nil || x.deadline.Cmp(next) < 0) {
				next = x.deadline
			}
		}
	}
	if next != nil {
		result.NextDeadline = deadlineTime(next)
		fields["next"] = result.NextDeadline.Format(time.RFC3339Nano)
	}
	g.record("pumped", false, nil, fields)
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
	s.queue = append(s.queue, workItem{delivery: delivery{
		script: s, message: Message{Name: "error", Args: []Value{{x.run.Error}}},
		from: x.id, during: &during,
	}})
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
func (g *Group) finish(s *Script, x *execution, common map[string]string, seal func()) *RunEnd {
	r := x.run
	end, outcome := "return", Completed
	if r.Passed {
		end = "pass"
	}
	if r.Vetoed {
		end = "veto"
		if r.VetoReason.Kind != corevalue.Nothing {
			common["value"] = coretrace.Display(r.VetoReason)
		}
		if !x.openVerdict() {
			g.record("note", false, []string{string(x.id)}, map[string]string{"kind": "no-verdict"})
		}
	}
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
		for _, id := range r.FaultAbandons {
			g.record("abandon", false, []string{id}, nil)
		}
		r.FaultAbandons = nil
	case machine.Unhandled:
		end, outcome = "unhandled", UnhandledOutcome
	case machine.Cancelled:
		end, outcome = "cancel", Cancelled
	case machine.Dropped:
		end, outcome = "dropped", Dropped
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
	g.abandonSend(x)
	g.writeRaises(x, len(r.Raises))
	common["state"] = fmt.Sprint(s.persistentWithoutRun(x))
	common["end"] = end
	g.record("seg", false, []string{string(x.id), x.how}, common)
	g.writeAbandon(x)
	seal()
	report := &RunEnd{Script: s.name, Run: x.id, Delivery: x.delivery.id, Handler: x.handler, Outcome: outcome, Result: Value{r.Result}, Fuel: r.Fuel, Alloc: r.Alloc, Limit: ""}
	if outcome == Cancelled && (r.CancelCode != "" || r.CancelLimit != "") {
		report.CleanupFailed = &CleanupFailure{Code: r.CancelCode, Limit: r.CancelLimit}
	}
	outputs := map[string]string{"outcome": []string{"completed", "errored", "limit-fault", "cancelled", "unhandled", "dropped"}[outcome], "delivery": string(x.delivery.id), "handler": x.handler, "fuel": fmt.Sprint(r.Fuel), "alloc": fmt.Sprint(r.Alloc)}
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

// A clause is busy until all of its selected, unparked Runs have ended.
func (s *Script) releaseParked(clause int) {
	if clause < 0 {
		return
	}
	for _, x := range s.runs {
		if x.clause == clause && !x.parked {
			return
		}
	}
	for _, x := range s.runs {
		if x.clause == clause && x.parked {
			x.parked = false
			x.how = "resume"
			s.queue = append(s.queue, workItem{run: x})
			return
		}
	}
}

func (s *Script) retainedOutside(exclude *execution) int64 {
	size := s.mailboxSize()
	for _, x := range s.runs {
		if x != exclude {
			size += x.run.RetainedSize()
		}
	}
	return size
}

func (g *Group) cancelExecution(s *Script, x *execution) {
	if x.run.Cancelling {
		return
	}
	queued := x == s.active
	for _, item := range s.queue {
		if item.run == x {
			queued = true
			break
		}
	}
	x.deadline = nil
	x.parked = false
	g.abandonSend(x)
	x.run.Cancel(s.limits.CleanupBudget)
	if !queued {
		x.how = "resume"
		s.queue = append(s.queue, workItem{run: x})
	}
}

func (g *Group) selectClause(s *Script, x *execution, allow func()) {
	r := x.run
	body := s.state.Unit.Bodies[r.Frames[0].Body]
	policy := machine.QueuePolicy(body)
	busy := false
	for _, other := range s.runs {
		if other != x && other.clause == body.Index {
			busy = true
			break
		}
	}
	if !r.AcceptClause(busy && (policy == "queued" || policy == "dropping")) {
		return
	}
	x.clause = body.Index
	x.deciding = machine.DecidingClause(body)
	switch {
	case busy && policy == "queued":
		r.Park()
	case busy && policy == "dropping":
		r.Drop()
	case policy == "replacing" && !r.Frames[0].Clause:
		g.replaceEarlier(s, x)
	}
	if !x.deciding && (r.Status == machine.Running || r.Status == machine.Parked) && !r.Frames[0].Clause {
		allow()
	}
}

func (g *Group) replaceEarlier(s *Script, x *execution) {
	for _, other := range s.runs {
		if other != x && other.clause == x.clause && !other.openVerdict() {
			g.cancelExecution(s, other)
		}
	}
}

func (g *Group) writeRaises(x *execution, from int) {
	for _, raise := range x.run.Raises[max(from, x.raisesWritten):] {
		fields := map[string]string{"at": fmt.Sprintf("%s:%d", x.delivery.script.name, raise.PC), "pos": fmt.Sprintf("%d:%d", raise.Instruction.Pos.Line, raise.Instruction.Pos.Column)}
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
	x.raisesWritten = len(x.run.Raises)
	if !x.run.Cancelling {
		g.writeAbandon(x)
	}
}

func (g *Group) writeAbandon(x *execution) {
	for _, id := range x.run.Abandons {
		g.record("abandon", false, []string{id}, nil)
	}
	x.run.Abandons = nil
	if x.abandonCall != "" {
		g.record("abandon", false, []string{string(x.abandonCall)}, nil)
		x.abandonCall = ""
	}
}
