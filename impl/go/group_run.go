package northtalk

import (
	"fmt"
	"math/big"
	"slices"
	"sort"
	"strconv"
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
		if o.MaxJoin > 0 || o.Set&OverrideMaxJoin != 0 {
			width = min(width, o.MaxJoin)
		}
		if o.FuelPerRun > 0 || o.Set&OverrideFuelPerRun != 0 {
			fuel = min(fuel, o.FuelPerRun)
		}
		if o.AllocPerRun > 0 || o.Set&OverrideAllocPerRun != 0 {
			alloc = min(alloc, o.AllocPerRun)
		}
	}
	limits := machine.Limits{Bounded: true, Fuel: fuel, Alloc: alloc, Persistent: s.limits.PersistentState, Depth: s.limits.CallDepth, Pattern: s.limits.PatternSize, Join: width}
	var r *machine.Run
	if d.function != nil {
		r = machine.StartFunction(s.state, *d.function, args, limits)
	} else {
		r = machine.StartDelivery(s.state, d.message.Name, args, limits)
	}
	r.Target = d.targetValue()
	if d.during != nil {
		r.SetDuring(*d.during)
	}
	handler := ""
	if d.function != nil {
		handler = Value{*d.function}.String()
	} else if s.hasHandler(d.message.Name) {
		handler = d.message.Name
	}
	s.active = &execution{run: r, delivery: d, id: RunID(fmt.Sprintf("%s/r%d", s.name, s.counters.Runs)), segment: 1, handler: handler, clause: -1, how: "start"}
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
		if d.function != nil {
			size += machine.Size(*d.function)
		}
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
		s        *Script
		x        *execution
		member   *memberTimer
		deadline *big.Int
		order    int64
	}
	var due []timer
	now := clockNanos(g.clock)
	for _, s := range g.scripts {
		for _, x := range s.runs {
			if x.deadline != nil && x.deadline.Cmp(now) <= 0 {
				due = append(due, timer{s: s, x: x, deadline: x.deadline, order: x.timerOrder})
			}
			for n := range x.memberTimers {
				t := &x.memberTimers[n]
				if t.deadline.Cmp(now) <= 0 {
					due = append(due, timer{s: s, x: x, member: t, deadline: t.deadline, order: t.order})
				}
			}
		}
	}
	sort.Slice(due, func(i, j int) bool {
		a, b := due[i], due[j]
		if cmp := a.deadline.Cmp(b.deadline); cmp != 0 {
			return cmp < 0
		}
		return a.order < b.order
	})
	for _, t := range due {
		if t.member != nil {
			j := t.x.run.Join
			if j == nil || j.Ready {
				continue
			}
			p := machine.SendResume{Timeout: true, AfterMS: t.member.ms}
			if pending := g.calls[CallID(t.member.id)]; pending != nil {
				p.Capability = true
				p.Call = t.member.id
				pending.pending = false
				pending.cancel()
			}
			if t.x.run.SettleJoin(t.member.id, p) {
				g.cancelPendingAbandons(t.x)
				t.x.memberTimers = nil
				t.x.how = "resume"
				t.s.queue = append(t.s.queue, workItem{run: t.x})
			}
			continue
		}
		if t.x.run.EventWait != nil {
			t.x.run.TimeoutEvent()
		}

		if t.x.run.SendWait {
			p := machine.SendResume{Timeout: true, AfterMS: int64(t.x.maxWait() / time.Millisecond)}
			if t.x.run.OperationWait {
				pending := g.calls[t.x.waitCall]
				p.Capability = true
				p.Call = string(t.x.waitCall)
				p.AfterMS = int64(operationWait(pending.op, t.x) / time.Millisecond)
				pending.pending = false
				pending.cancel()
			}
			g.abandonSend(t.x)
			t.x.run.SettleSend(p)
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
			name := ""
			if d.script != nil {
				name = d.script.name
			}
			report.Undecided = []UndecidedBy{{Script: name, Run: run, Outcome: outcome}}
		}
		report.Broadcast = d.broadcast
		if d.broadcast != "" {
			report.Delivery = ""
		}
		report = d.decision.sealReport(report)
		if report == nil {
			return
		}
		result.Reports = append(result.Reports, report)
		g.recordDecided(report)
		settlements = append(settlements, d.decision.finish)
	}
	terminal := func(d delivery) {
		g.unhandled(d, &result.Reports)
		g.reply(d.reply, corevalue.Value{}, "unhandled", corevalue.Value{})
		seal(d, "", Allowed, Nothing, UnhandledOutcome)
		if d.pending != nil {
			settlements = append(settlements, func() { d.pending.settle(Nothing, sendFailure("unhandled", nil)) })
		}
	}
	land := func(current *execution) bool {
		landed := g.landControls(&result.Reports, func(d delivery) {
			if current != nil && d.script.active == current {
				if current.stopReason == nil {
					reason := d.reason
					current.stopReason = &reason
					current.run.Status = machine.Stopped
				}
			} else {
				g.stopScript(d.script, d.reason, &result.Reports, &settlements, seal)
			}
		})
		if current != nil && g.effectUnknown {
			g.markEffectUnknown(current)
		}
		return landed
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
	var drained []delivery
	for _, d := range inputs {
		if d.kind == "broadcast" || d.kind == "decide-broadcast" {
			if len(d.children) == 0 {
				drained = append(drained, d)
			} else {
				drained = append(drained, d.children...)
			}
		} else {
			drained = append(drained, d)
		}
	}
	for _, d := range drained {
		if d.kind == "stop" {
			g.stopScript(d.script, d.reason, &result.Reports, &settlements, seal)
			continue
		}
		if d.kind == "broadcast" || d.kind == "decide-broadcast" {
			seal(d, "", Allowed, Nothing, Completed)
			continue
		}
		if d.kind == "dispose" {
			g.mu.Lock()
			already := d.object.disposed.Swap(true)
			owner := d.object.owner
			g.mu.Unlock()
			if !already && owner != nil {
				g.disposeOwner(owner, &result.Reports, &settlements, seal)
			}
			continue
		}
		if d.kind == "set-parent" {
			g.mu.Lock()
			code := g.parentError(d.object, d.parent)
			if code == "" {
				d.object.parent = d.parent
			}
			g.mu.Unlock()
			if code != "" {
				result.Reports = append(result.Reports, &HostError{code, "invalid queued parent relationship"})
				g.record("refused", false, nil, map[string]string{"code": corevalue.DisplayText(string(code))})
			}
			continue
		}
		if d.kind == "cancel-run" {
			g.applyCancelRun(d, &result.Reports)
			continue
		}
		if d.settlement != nil {
			if d.settlement.restore != nil {
				p := g.calls[d.reply]
				fuel := g.applyRestoredSettlement(d, &result.Reports)
				if p != nil {
					used[p.s] += fuel
					p.s.counters.FuelTotal += fuel
				}
				result.FuelUsed += fuel
				// A reissued Start is a Host crossing just like a first Start.
				if p != nil {
					land(p.x)
				}
			} else {
				g.settleOperation(d)
			}
			continue
		}
		if d.kind == "revoke" {
			if grant := d.script.grants[d.fields["grant"]]; grant != nil {
				grant.revoked = true
			}
			continue
		}
		if d.cancel == "" {
			if d.function != nil && (d.function.Function.Owner != d.script.state || d.script.state.Gone) {
				g.release(d.script)
				g.record("note", false, []string{string(d.id)}, map[string]string{"kind": "function-gone"})
				if d.pending != nil {
					settlements = append(settlements, func() { d.pending.settle(Nothing, sendFailure("function gone", nil)) })
				}
				continue
			}
			if moved, changed := g.moveDelivery(d); changed {
				if moved.script == nil {
					g.unrouted = append(g.unrouted, moved)
				}
				continue
			}
			if d.script == nil {
				g.unrouted = append(g.unrouted, d)
			} else {
				d.script.queue = append(d.script.queue, workItem{delivery: d})
				if d.script.stopped {
					g.disposeOwner(d.script, &result.Reports, &settlements, seal)
				}
			}
			continue
		}
		found := false
		cancelBroadcast := strings.HasPrefix(string(d.cancel), "b")
		matches := func(q delivery) bool {
			return (q.id == d.cancel || cancelBroadcast && q.broadcast == BroadcastID(d.cancel)) && (q.decision == nil || !q.decision.isSealed())
		}
		cancelQueued := func(q delivery, script string) {
			result.Reports = append(result.Reports, &RunEnd{Script: script, Delivery: q.id, Broadcast: q.broadcast, Outcome: Cancelled})
			fields := map[string]string{"outcome": "cancelled", "delivery": string(q.id), "fuel": "0", "alloc": "0"}
			if q.broadcast != "" {
				fields["broadcast"] = string(q.broadcast)
			}
			g.record("run", false, nil, fields)
			if q.pending != nil {
				settlements = append(settlements, func() { q.pending.settle(Nothing, sendFailure("cancelled", nil)) })
			}
			seal(q, "", Undecided, Nothing, Cancelled)
		}
		for j, q := range g.unrouted {
			if matches(q) {
				g.unrouted = slices.Delete(g.unrouted, j, j+1)
				cancelQueued(q, "")
				found = true
				break
			}
		}
		for _, s := range g.scripts {
			if found && !cancelBroadcast {
				break
			}
			for j := 0; j < len(s.queue); {
				item := s.queue[j]
				q := item.delivery
				if item.run == nil && matches(q) {
					s.queue = slices.Delete(s.queue, j, j+1)
					g.release(s)
					cancelQueued(q, s.name)
					found = true
					if !cancelBroadcast {
						break
					}
					continue
				}
				j++
			}
			if !found || cancelBroadcast {
				for _, x := range s.runs {
					if matches(x.delivery) {
						g.cancelExecution(s, x, &result.Reports)
						found = true
						if !cancelBroadcast {
							break
						}
					}
				}
			}
		}

	}
	for _, d := range g.unrouted {
		moved, _ := g.moveDelivery(d)
		if moved.script == nil {
			terminal(moved)
		}
	}
	g.unrouted = nil
	if g.effectUnknown {
		g.stopEffectGroup(&result.Reports, &settlements, seal)
	}

	// Only timers retained from an earlier Pump fire, after Host inputs.
	if g.restored {
		for _, id := range orderedCalls(g.calls) {
			if g.unsettled[id] != nil {
				g.loseRestoredCall(id, "call lost")
			}
		}
		g.unsettled = nil
		g.restored = false
	}
	for _, report := range g.deferredDecisions {
		result.Reports = append(result.Reports, report)
		g.recordDecided(report)
	}
	g.deferredDecisions = nil
	g.fireTimers()

	for {
		progress := false
		for _, s := range g.scripts {
			if s.stopped || skipped[s] || s.active == nil && len(s.queue) == 0 {
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
					if s.active.run.Status == machine.Suspended || s.active.run.Status == machine.Parked {
						s.active.segment++
					}
					s.active.run.Resume()
				} else {
					d := item.delivery
					if moved, changed := g.moveDelivery(d); changed {
						if moved.script == nil {
							terminal(moved)
						}
						progress = true
						continue
					}
					g.release(s)
					var fuel, alloc int64
					if d.function == nil {
						fuel, alloc = g.observe(s, d, func() { seal(d, "", Allowed, Nothing, Completed) })
					}
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
			// Host arity validation can raise before the first execution segment.
			if x.how == "start" && x.delivery.function != nil && r.Status == machine.Errored {
				g.writeRaises(x, x.raisesWritten)
			}
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
					resume := func(p machine.SendResume) (corevalue.Value, *corevalue.Value) {
						return g.resumeOperation(p, &result.Reports)
					}
					r.ResumeSendOperation(resume)
					r.ResumeJoinOperation(resume)
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
				r.ExecuteHosted(remaining, func() {
					if machine.QueuePolicy(s.state.Unit.Bodies[x.clause]) == "replacing" {
						g.replaceEarlier(s, x, &result.Reports)
						r.PersistentBase = s.retainedOutside(x)
					}
					if !x.deciding {
						seal(x.delivery, x.id, Allowed, Nothing, Completed)
					}
				}, func(to machine.Receiver, message string, args []corevalue.Value, wait bool) *corevalue.Value {
					err := g.send(x, to, message, args, wait, &result.Reports)
					if err == nil {
						r.PersistentBase = s.retainedOutside(x)
					}
					return err
				}, func(grant, op string, args []corevalue.Value, pay func(int64, int64) bool) (corevalue.Value, *corevalue.Value, bool) {
					return g.operation(s, x, grant, op, args, pay, &result.Reports, func() { land(x) })
				}, func(object corevalue.Value, name string, set bool, input corevalue.Value, pay func(int64, int64) bool) (corevalue.Value, *corevalue.Value) {
					return g.property(s, x, object, name, set, input, pay, &result.Reports, func() { land(x) })
				})
				if r.Status != machine.Dispatching {
					break
				}
				g.writeRaises(x, raised)
				raised = len(r.Raises)
				g.selectClause(s, x, &result.Reports, func() { seal(x.delivery, x.id, Allowed, Nothing, Completed) })
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
				if x.delivery.broadcast != "" {
					common["broadcast"] = string(x.delivery.broadcast)
				}
				if x.delivery.id != "" {
					common["delivery"] = string(x.delivery.id)
				}
				if x.delivery.from != "" {
					common["from"] = string(x.delivery.from)
				}
				if x.delivery.function != nil {
					common["fn"] = Value{*x.delivery.function}.String()
				} else if x.handler != "" {
					common["handler"] = x.handler
				}
				if r.Clause > 0 {
					common["clause"] = fmt.Sprint(r.Clause)
				}
			}
			if r.Status == machine.Preempted {
				// An atomic search/lookup may spend both limits; slice wins
				// in the canonical Trace, matching the post-instruction check.
				if o.FuelSlice > 0 && used[s] >= budget[s] {
					by = "slice"
				}
				common["by"] = by
				g.record("preempt", false, []string{string(x.id), x.how}, common)
				g.writeAbandon(x)
				x.how = "continue"
				skipped[s] = true
				result.State = Sliced
				continue
			}
			if r.Status == machine.Stopped {
				s.state.Variables = r.Base
				g.finalizeParticipant(s, x, &result.Reports)
				common["state"], common["end"] = fmt.Sprint(s.persistentWithoutRun(x)), "stop"
				g.record("seg", false, []string{string(x.id), x.how}, common)
				if g.effectUnknown {
					g.stopEffectGroup(&result.Reports, &settlements, seal)
				} else {
					g.stopScript(s, *x.stopReason, &result.Reports, &settlements, seal)
				}
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
				g.finalizeParticipant(s, x, &result.Reports)
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
						g.cancelPendingAbandons(x)
						s.queue = append(s.queue, workItem{run: x})
					} else {
						g.installJoinTimers(x)
					}
				} else if r.SendWait {
					x.deadline = new(big.Int).Add(clockNanos(g.clock), big.NewInt(int64(x.maxWait())))
					common["end"] = "send-wait"
					if r.FunctionWait {
						common["end"] = "call-value-wait"
					}
					if r.OperationWait {
						common["end"] = "ask-wait"
						p := g.calls[x.waitCall]
						x.deadline = new(big.Int).Add(clockNanos(g.clock), big.NewInt(int64(operationWait(p.op, x))))
					}
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
			report := g.finish(s, x, common, &result.Reports, func() {
				if r.Status == machine.Completed && x.effect == nil && !r.Passed && x.openVerdict() {
					verdict := Allowed
					if r.Vetoed {
						verdict = Vetoed
					}
					seal(x.delivery, x.id, verdict, Value{r.VetoReason}, Completed)
				}
			})
			if report == nil {
				g.stopEffectGroup(&result.Reports, &settlements, seal)
				continue
			}
			result.Reports = append(result.Reports, report)
			reason := map[Outcome]string{Errored: "errored", LimitFault: "limit fault", Cancelled: "cancelled", UnhandledOutcome: "unhandled", Dropped: "dropped", EffectFailureOutcome: "effect failed"}[report.Outcome]
			if r.Passed {
				reason = "unhandled"
			}
			climbed := (report.Outcome == UnhandledOutcome || r.Passed) && x.delivery.during == nil && g.climb(x)
			if !climbed {
				g.reply(x.delivery.reply, report.Result.inner, reason, r.Error)
			}
			if report.Outcome == Errored && x.delivery.message.Name != "error" {
				g.queueError(s, x)
			}
			if !climbed && (report.Outcome == UnhandledOutcome || r.Passed) && x.delivery.during == nil {
				g.unhandled(x.delivery, &result.Reports)
			}

			if !climbed && (report.Outcome == UnhandledOutcome || r.Passed) {
				seal(x.delivery, x.id, Allowed, Nothing, UnhandledOutcome)
			} else if !climbed && report.Outcome != Completed {
				seal(x.delivery, x.id, Undecided, Nothing, report.Outcome)
			}
			if p := x.delivery.pending; p != nil && !climbed {
				settlements = append(settlements, func() {
					if report.Outcome == Completed && !r.Passed {
						p.settle(report.Result, nil)
					} else {
						reason := map[Outcome]string{Errored: "errored", LimitFault: "limit fault", Cancelled: "cancelled", UnhandledOutcome: "unhandled", Dropped: "dropped", EffectFailureOutcome: "effect failed"}[report.Outcome]
						if r.Passed {
							reason = "unhandled"
						}
						p.settle(Nothing, sendFailure(reason, report.Error))
					}
				})
			}
			g.discardOperationCalls(x)
			s.active = nil
			for j, live := range s.runs {
				if live == x {
					s.runs = slices.Delete(s.runs, j, j+1)
					s.releaseParked(x.clause)
					break
				}
			}
		}
		for _, s := range g.scripts {
			if g.stoppedSends[s] {
				g.disposeOwner(s, &result.Reports, &settlements, seal)
			}
		}
		g.stoppedSends = nil
		for _, d := range g.orphanReplies {
			g.reply(d.reply, corevalue.Value{}, "unhandled", corevalue.Value{})
		}
		g.orphanReplies = nil
		if land(nil) {
			progress = true
		}
		if g.effectUnknown {
			g.stopEffectGroup(&result.Reports, &settlements, seal)
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
	allStopped := len(g.scripts) > 0
	for _, s := range g.scripts {
		allStopped = allStopped && s.stopped
	}
	if allStopped {
		result.State = Stopped
	}
	fields := map[string]string{"state": []string{"idle", "sliced", "stopped"}[result.State], "fuel": fmt.Sprint(result.FuelUsed)}
	var next *big.Int
	for _, s := range g.scripts {
		for _, x := range s.runs {
			for _, t := range x.memberTimers {
				if next == nil || t.deadline.Cmp(next) < 0 {
					next = t.deadline
				}
			}
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
		script: s, target: s.owner, message: Message{Name: "error", Args: []Value{{x.run.Error}}},
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
func (g *Group) finish(s *Script, x *execution, common map[string]string, reports *[]Report, seal func()) *RunEnd {
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
		fields := map[string]string{"limit": r.Limit, "at": fmt.Sprintf("%s:%d", r.CodeName(), r.PC), "pos": fmt.Sprintf("%d:%d", r.At.Pos.Line, r.At.Pos.Column)}
		if len(r.Rollback) > 0 {
			fields["rollback"] = "[" + strings.Join(r.Rollback, ", ") + "]"
		}
		g.record("fault", false, []string{string(x.id)}, fields)
		for _, id := range r.FaultAbandons {
			g.abandonOperation(id)
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
	g.finalizeParticipant(s, x, reports)
	if g.effectUnknown {
		end = "stop"
	} else if x.effect != nil {
		end, outcome = "effect-failed", EffectFailureOutcome
		delete(common, "value")
	}
	common["state"] = fmt.Sprint(s.persistentWithoutRun(x))
	common["end"] = end
	g.record("seg", false, []string{string(x.id), x.how}, common)
	g.writeAbandon(x)
	if g.effectUnknown {
		return nil
	}
	seal()
	report := &RunEnd{Script: s.name, Run: x.id, Delivery: x.delivery.id, Broadcast: x.delivery.broadcast, Handler: x.handler, Outcome: outcome, Result: Value{r.Result}, Fuel: r.Fuel, Alloc: r.Alloc, Limit: ""}
	if outcome == Cancelled && (r.CancelCode != "" || r.CancelLimit != "") {
		report.CleanupFailed = &CleanupFailure{Code: r.CancelCode, Limit: r.CancelLimit}
	}
	outputs := map[string]string{"outcome": []string{"completed", "errored", "limit-fault", "cancelled", "unhandled", "dropped", "effect-failed"}[outcome], "delivery": string(x.delivery.id), "handler": x.handler, "fuel": fmt.Sprint(r.Fuel), "alloc": fmt.Sprint(r.Alloc)}
	if x.effect != nil {
		report.Effect = x.effect
		outputs["effect"] = effectDisplay(x.effect)
	}
	if x.delivery.broadcast != "" {
		outputs["broadcast"] = string(x.delivery.broadcast)
	}
	if x.delivery.function != nil {
		delete(outputs, "handler")
		outputs["fn"] = Value{*x.delivery.function}.String()
	}
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
		report.At = Location{Unit: r.CodeName(), Handler: x.handler, Line: r.At.Pos.Line, Col: r.At.Pos.Column, PC: r.PC}
		if outcome == LimitFault && len(r.Frames) > 0 {
			report.At.Handler = r.CurrentCode().Unit.Bodies[r.Frames[len(r.Frames)-1].Body].Checked.Name
		}
		if outcome == Errored {
			for j := len(r.Raises) - 1; j >= 0; j-- {
				a := r.Raises[j]
				if !a.Guard {
					report.At = Location{Unit: a.Unit, Handler: a.Handler, Line: a.Instruction.Pos.Line, Col: a.Instruction.Pos.Column, PC: a.PC}
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

func (g *Group) cancelExecution(s *Script, x *execution, reports *[]Report) {
	if g.effectUnknown || x.run.Cancelling || x.run.Status == machine.Stopped {
		return
	}
	queued := x == s.active
	for _, item := range s.queue {
		if item.run == x {
			queued = true
			break
		}
	}
	if x.participant != nil {
		g.abandonGrantScopes(s, x, x.participant.name, reports)
		g.rollbackParticipant(s, x, reports)
		if g.effectUnknown {
			return
		}
	}
	x.segment++
	x.deadline = nil
	x.memberTimers = nil
	x.parked = false
	g.abandonSend(x)
	g.discardOperationCalls(x)
	x.run.Cancel(s.limits.CleanupBudget)
	if !queued {
		x.how = "resume"
		s.queue = append(s.queue, workItem{run: x})
	}
}

func (g *Group) selectClause(s *Script, x *execution, reports *[]Report, allow func()) {
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
		g.replaceEarlier(s, x, reports)
	}
	if !x.deciding && (r.Status == machine.Running || r.Status == machine.Parked) && !r.Frames[0].Clause {
		allow()
	}
}

func (g *Group) replaceEarlier(s *Script, x *execution, reports *[]Report) {
	for _, other := range s.runs {
		if other != x && other.clause == x.clause && !other.openVerdict() {
			g.cancelExecution(s, other, reports)
		}
	}
}

func (g *Group) writeRaises(x *execution, from int) {
	for j, raise := range x.run.Raises[max(from, x.raisesWritten):] {
		g.writeOffers(x, max(from, x.raisesWritten)+j)
		fields := map[string]string{"at": fmt.Sprintf("%s:%d", raise.Unit, raise.PC), "pos": fmt.Sprintf("%d:%d", raise.Instruction.Pos.Line, raise.Instruction.Pos.Column)}
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
	g.writeOffers(x, x.raisesWritten)
	if !x.run.Cancelling {
		g.writeAbandon(x)
	}
}

func (g *Group) writeOffers(x *execution, raised int) {
	for x.offersWritten < len(x.run.OfferRecords) {
		rec := x.run.OfferRecords[x.offersWritten]
		if rec.RaiseCount > raised {
			break
		}
		fields := map[string]string{"attempt": strconv.Itoa(rec.Attempt), "target": fmt.Sprintf("%s:%d", rec.TargetUnit, rec.TargetPC)}
		if rec.Kind == "offer-chosen" {
			fields["name"] = corevalue.DisplayText(rec.Name)
			fields["at"] = fmt.Sprintf("%s:%d", rec.Unit, rec.PC)
			if len(rec.Args) > 0 {
				fields["args"] = coretrace.Display(corevalue.NewList(rec.Args))
			}
		}
		g.record(rec.Kind, false, []string{string(x.id)}, fields)
		x.offersWritten++
	}
}

func (g *Group) writeAbandon(x *execution) {
	for _, id := range x.run.Abandons {
		g.abandonOperation(id)
		g.record("abandon", false, []string{id}, nil)
	}
	x.run.Abandons = nil
	if x.abandonCall != "" {
		g.abandonOperation(string(x.abandonCall))
		g.record("abandon", false, []string{string(x.abandonCall)}, nil)
		x.abandonCall = ""
	}

	g.pruneOperationCalls(x)
}
