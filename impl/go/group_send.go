package northtalk

import (
	"fmt"
	"github.com/odogono/odgn-talk/impl/go/internal/machine"
	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
	"time"
)

// A paid Script send joins the work queue immediately, never the Host input
// queue. Capacity includes accepted Host inputs, even during this Pump.
func (g *Group) send(x *execution, to, message string, args []corevalue.Value, wait bool) bool {
	g.mu.Lock()
	s := g.script(to) // the receiver token was validated by load-object or me
	if s.reserved >= s.limits.MailboxDepth {
		g.mu.Unlock()
		return false
	}
	s.reserved++
	g.mu.Unlock()
	vs := make([]Value, len(args))
	for j, v := range args {
		vs[j] = Value{v}
	}
	from := x.id
	var reply CallID
	if wait {
		x.calls++
		reply = CallID(fmt.Sprintf("%s.c%d", x.id, x.calls))
		if x.run.Join != nil {
			x.run.AddJoinMember(string(reply))
		} else {
			x.waitCall = reply
		}
		from = RunID(reply)
	}
	s.queue = append(s.queue, workItem{delivery: delivery{script: s, message: Message{Name: message, Args: vs}, from: from, reply: reply}})
	g.writeRaises(x, x.raisesWritten)
	fields := map[string]string{"to": to, "message": message}
	if len(vs) > 0 {
		fields["args"] = argsDisplay(vs)
	}
	if wait {
		fields["wait"] = "yes"
		if x.run.Join != nil {
			fields["wait"] = "join"
		}
	}
	g.record("send", false, []string{string(from)}, fields)
	return true
}

func (g *Group) reply(call CallID, answer corevalue.Value, reason string, failure corevalue.Value) {
	if call == "" {
		return
	}
	for _, s := range g.scripts {
		for _, x := range s.runs {
			if x.run.Join != nil {
				x.removeMemberTimer(string(call))
				if x.run.SettleJoin(string(call), machine.SendResume{Answer: answer, Reason: reason, Error: failure}) {
					x.deadline = nil
					x.memberTimers = nil
					g.cancelPendingAbandons(x)
					x.how = "resume"
					s.queue = append(s.queue, workItem{run: x})
				}
				continue
			}
			if x.waitCall != call || !x.run.SendWait {
				continue
			}
			x.waitCall = ""
			x.deadline = nil
			x.run.SettleSend(machine.SendResume{Answer: answer, Reason: reason, Error: failure})
			x.how = "resume"
			s.queue = append(s.queue, workItem{run: x})
			return
		}
	}
}

func (g *Group) abandonSend(x *execution) {
	if x.waitCall != "" {
		x.abandonCall = x.waitCall
		x.waitCall = ""
		x.run.SendWait = false
	}
}

func (x *execution) maxWait() time.Duration {
	if o := x.delivery.message.Limits; o != nil && o.MaxWait > 0 {
		return o.MaxWait
	}
	return x.delivery.script.limits.MaxWait
}
