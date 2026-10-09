package northtalk

import (
	"fmt"
	"slices"

	"github.com/odogono/odgn-talk/impl/go/internal/machine"
	coretrace "github.com/odogono/odgn-talk/impl/go/internal/trace"
	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
)

// Settle reserves a pending id immediately, and queues its settlement for the
// first Pump. The adopted Call answers into the restored Group.
func (g *Group) Settle(id CallID, s Settlement) (*Call, error) {
	fields := map[string]string{}
	count := 0
	if s.Answer != nil {
		count++
		fields["how"] = "answer"
		fields["value"] = coretrace.Display(s.Answer.inner)
	}
	if s.Fail != nil {
		count++
		fields["how"] = "fail"
		fields["error"] = coretrace.Display(hostFailureValue(s.Fail))
	}
	if s.Reissue {
		count++
		fields["how"] = "reissue"
	}
	if s.Adopt {
		count++
		fields["how"] = "adopt"
	}
	g.mu.Lock()
	refuse := func(code HostErrorCode, detail string) (*Call, error) {
		g.mu.Unlock()
		g.recordRefusal("settle", []string{string(id)}, fields, code)
		return nil, &HostError{code, detail}
	}
	if !g.settlementsOpen || g.unsettled[id] == nil {
		return refuse(UnknownCall, "call is not awaiting a restored settlement")
	}
	if count != 1 {
		return refuse(InvalidValue, "settlement must select exactly one outcome")
	}
	if s.Answer != nil && !validGroup(s.Answer.inner, g) || s.Fail != nil && !validGroup(s.Fail.Data.inner, g) {
		return refuse(WrongGroup, "settlement contains a foreign Value")
	}
	copy := s
	if s.Answer != nil {
		v := *s.Answer
		copy.Answer = &v
	}
	if s.Fail != nil {
		e := *s.Fail
		copy.Fail = &e
	}
	g.inputs = append(g.inputs, delivery{kind: "settle", reply: id, fields: fields, settlement: &operationSettlement{restore: &copy}})
	reserved := g.unsettled[id]
	delete(g.unsettled, id)
	var call *Call
	if s.Adopt {
		call = reserved
	}
	ready := g.options.OnReady
	g.mu.Unlock()
	if ready != nil {
		ready()
	}
	return call, nil
}

func (g *Group) applyRestoredSettlement(d delivery, reports *[]Report) int64 {
	p := g.calls[d.reply]
	if p == nil || !p.pending || p.x.run.Cancelling {
		return 0
	}
	switch p.x.run.Status {
	case machine.Completed, machine.Errored, machine.Faulted, machine.Unhandled, machine.Cancelled, machine.Dropped, machine.Stopped:
		return 0
	}
	settlement := d.settlement.restore
	if settlement.Answer != nil {
		g.settleOperation(delivery{kind: "answer", reply: d.reply, settlement: &operationSettlement{value: *settlement.Answer}})
		return 0
	}
	if settlement.Fail != nil {
		g.settleOperation(delivery{kind: "fail", reply: d.reply, settlement: &operationSettlement{err: settlement.Fail}})
		return 0
	}
	if settlement.Adopt {
		return 0
	}
	if !p.rebound {
		g.loseRestoredCall(d.reply, "capability revoked")
		return 0
	}
	x := p.x
	before := x.run.Fuel
	call := p.call
	call.mu.Lock()
	call.starting = true
	call.charge = x.run.ChargeHost
	call.fuelLeft = x.run.HostFuelLeft
	call.now = g.clock
	call.charged = 0
	call.mu.Unlock()
	_, err := invokeOperation(p.op, call, slices.Clone(p.args))
	call.finish()
	fields := map[string]string{"op": call.grantName + "." + p.name, "args": coretrace.Display(corevalue.NewList(publicValues(p.args)))}
	if call.charged != 0 {
		fields["charged"] = fmt.Sprint(call.charged)
	}
	g.record("call", false, []string{string(call.id)}, fields)
	if call.reached {
		// The resuming Segment starts at the saved suspension, whose writes are
		// already committed. The cutoff is attributed to that paid ask.
		if x.run.Status == machine.Suspended {
			x.run.Base = slices.Clone(p.s.state.Variables)
		}
		x.run.FaultHostFuel()
		p.pending = false
		p.cancel()
		if !slices.Contains(x.run.FaultAbandons, string(call.id)) {
			x.run.FaultAbandons = append(x.run.FaultAbandons, string(call.id))
		}
		x.waitCall = ""
		x.deadline = nil
		x.memberTimers = nil
		x.how = "resume"
		if p.s.active != x && !slices.ContainsFunc(p.s.queue, func(w workItem) bool { return w.run == x }) {
			p.s.queue = append(p.s.queue, workItem{run: x})
		}
	} else if err != nil {
		failure, ok := err.(*ScriptError)
		if !ok {
			failure = &ScriptError{}
		}
		g.settleOperation(delivery{kind: "fail", reply: d.reply, settlement: &operationSettlement{err: failure}})
	}
	return x.run.Fuel - before
}
func publicValues(vs []Value) []corevalue.Value {
	out := make([]corevalue.Value, len(vs))
	for i, v := range vs {
		out[i] = v.inner
	}
	return out
}
func (g *Group) loseRestoredCall(id CallID, code string) {
	p := g.calls[id]
	if p == nil || !p.pending {
		return
	}
	g.settleOperation(delivery{kind: "fail", reply: id, settlement: &operationSettlement{err: &ScriptError{Code: code}, reason: code}})
}
