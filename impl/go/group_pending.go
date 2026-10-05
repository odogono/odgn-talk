package northtalk

import (
	"context"
	"fmt"
	"math/big"
	"time"

	"github.com/odogono/odgn-talk/impl/go/internal/decimal"
	"github.com/odogono/odgn-talk/impl/go/internal/machine"
	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
)

type operationCall struct {
	call    *Call
	cancel  context.CancelFunc
	s       *Script
	x       *execution
	op      Operation
	name    string
	pending bool
}
type operationSettlement struct {
	value Value
	err   *ScriptError
	fuel  int64
}
type memberTimer struct {
	id       string
	deadline *big.Int
	order    int64
	ms       int64
}

func operationWait(op Operation, x *execution) time.Duration {
	if op.MaxPending != 0 {
		return op.MaxPending
	}
	return x.maxWait()
}
func hostFailureValue(e *ScriptError) corevalue.Value {
	fields := []corevalue.Pair{}
	if e != nil {
		fields = append(fields, corevalue.Pair{Key: "code", Val: mustText(e.Code)})
		if e.Message != "" {
			fields = append(fields, corevalue.Pair{Key: "message", Val: mustText(e.Message)})
		}
		fields = append(fields, e.Data.inner.Entries...)
	}
	v, err := corevalue.NewMap(fields)
	if err != nil {
		// Keep the Host input's error field a map; resumption validates the raw failure.
		v, _ = corevalue.NewMap(nil)
	}
	return v
}
func (g *Group) settleOperation(d delivery) {
	pending := g.calls[d.reply]
	if pending == nil || !pending.pending {
		kind := "late-answer"
		if d.kind == "fail" {
			kind = "late-fail"
		}
		g.record("note", false, []string{string(d.reply)}, map[string]string{"kind": kind})
		return
	}
	pending.pending = false
	x, s := pending.x, pending.s
	p := machine.SendResume{Capability: true, Call: string(d.reply), Answer: d.settlement.value.inner, Fuel: d.settlement.fuel, Failed: d.kind == "fail"}
	if e := d.settlement.err; e != nil {
		p.FailureCode = e.Code
		p.FailureMessage = e.Message
		p.FailureData = e.Data.inner
	}
	if x.run.Join != nil {
		x.removeMemberTimer(string(d.reply))
		if x.run.SettleJoin(string(d.reply), p) {
			g.cancelPendingAbandons(x)
			x.memberTimers = nil
			x.how = "resume"
			s.queue = append(s.queue, workItem{run: x})
		}
	} else {
		x.waitCall = ""
		x.deadline = nil
		x.run.SettleSend(p)
		x.how = "resume"
		s.queue = append(s.queue, workItem{run: x})
	}
}
func (g *Group) resumeOperation(p machine.SendResume, reports *[]Report) (corevalue.Value, *corevalue.Value) {
	pending := g.calls[CallID(p.Call)]
	delete(g.calls, CallID(p.Call))
	if p.Timeout {
		after, _ := corevalue.NewQuantity(decimal.FromInt(p.AfterMS), "ms")
		e := operationError("timeout", []corevalue.Pair{{Key: "after", Val: after}, {Key: "capability", Val: mustText(pending.call.grantName)}, {Key: "operation", Val: mustText(pending.name)}})
		return corevalue.Value{}, &e
	}
	var err error
	if p.Failed {
		if p.FailureCode == "" {
			err = fmt.Errorf("Fail is not a ScriptError")
		} else {
			err = &ScriptError{Code: p.FailureCode, Message: p.FailureMessage, Data: Value{p.FailureData}}
		}
	}
	v, e, _ := g.completeOperation(pending.s, pending.x, pending.call.grantName, pending.name, pending.op, pending.call, nil, Value{p.Answer}, err, map[string]string{}, nil, p.Fuel, reports, pending.x.run.Cancelling)
	return v, e
}
func (g *Group) abandonOperation(id string) {
	if p := g.calls[CallID(id)]; p != nil {
		p.cancel()
		// A timeout still needs its identity on the next turn.
		p.pending = false
	}
}
func (g *Group) discardOperationCalls(x *execution) {
	for id, p := range g.calls {
		if p.x == x {
			p.cancel()
			delete(g.calls, id)
		}
	}
}
func (x *execution) removeMemberTimer(id string) {
	for n, t := range x.memberTimers {
		if t.id == id {
			x.memberTimers = append(x.memberTimers[:n], x.memberTimers[n+1:]...)
			return
		}
	}
}
func (g *Group) installJoinTimers(x *execution) {
	for _, m := range x.run.Join.Members {
		if m.Reply != nil {
			continue
		}
		ms := m.WaitMS
		if ms == 0 {
			ms = int64(x.maxWait() / time.Millisecond)
		}
		g.nextTimer++
		x.memberTimers = append(x.memberTimers, memberTimer{id: m.ID, ms: ms, deadline: new(big.Int).Add(clockNanos(g.clock), big.NewInt(ms*int64(time.Millisecond))), order: g.nextTimer})
	}
}

func (g *Group) cancelPendingAbandons(x *execution) {
	for _, id := range x.run.Abandons {
		g.abandonOperation(id)
	}
}

// Host handles live only while a pending call or a retained resumption needs
// them. A caught Join failure must not retain discarded siblings indefinitely.
func (g *Group) pruneOperationCalls(x *execution) {
	live := map[CallID]bool{}
	if x.waitCall != "" {
		live[x.waitCall] = true
	}
	if p := x.run.SendResume; p != nil && p.Capability {
		live[CallID(p.Call)] = true
	}
	if j := x.run.Join; j != nil {
		if j.Ready && j.Failure != nil {
			live[CallID(j.Failure.Call)] = true
		} else {
			for _, m := range j.Members {
				live[CallID(m.ID)] = true
			}
		}
	}
	for id, p := range g.calls {
		if p.x == x && !live[id] {
			if p.pending {
				p.cancel()
			}
			delete(g.calls, id)
		}
	}
}
