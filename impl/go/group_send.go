package northtalk

import (
	"fmt"
	"github.com/odogono/odgn-talk/impl/go/internal/machine"
	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
	"time"
)

// A paid Script send joins the work queue immediately, never the Host input
// queue. Capacity includes accepted Host inputs, even during this Pump.
func (g *Group) send(x *execution, to machine.Receiver, message string, args []corevalue.Value, wait bool, reports *[]Report) *corevalue.Value {
	d := delivery{message: Message{Name: message}, from: x.id}
	g.mu.Lock()
	label := to.Name
	if to.Function.Kind == corevalue.Function {
		d.function = &to.Function
		d.message.Name = Value{to.Function}.String()
		d.script = g.script(to.Function.Function.Home)
		d.target = d.script.owner
		label = d.script.name
	} else if to.Up {
		d.target = x.delivery.script.owner
		d.path = true
		d.after = x.delivery.script.owner
		if d.after != nil {
			d.script = g.nearestOwner(d.after.parent)
		}
	} else if to.Object.Kind == corevalue.Object {
		d.target = to.Object.Object.Handle.(*Object)
		d.path = true
		d.script = g.nearestOwner(d.target)
		label = Value{to.Object}.String()
	} else {
		d.script = g.script(to.Name)
		if d.script != nil {
			d.target = d.script.owner
		}
	}
	if d.script != nil && d.script.reserved >= d.script.limits.MailboxDepth {
		g.mu.Unlock()
		receiver := d.targetValue()
		if to.Up || to.Function.Kind == corevalue.Function {
			receiver = mustText(d.script.name)
		} else if to.Object.Kind != corevalue.Object {
			receiver = mustText(to.Name)
		}
		return machine.MailboxFull(receiver)
	}
	if d.script != nil {
		d.script.reserved++
	}
	g.mu.Unlock()
	for _, v := range args {
		d.message.Args = append(d.message.Args, Value{v})
	}
	if wait {
		x.calls++
		d.reply = CallID(fmt.Sprintf("%s.c%d", x.id, x.calls))
		if x.run.Join != nil {
			x.run.AddJoinMember(string(d.reply))
		} else {
			x.waitCall = d.reply
		}
		d.from = RunID(d.reply)
	}
	d.ancestry = g.ancestry(d)
	g.writeRaises(x, x.raisesWritten)
	if d.script == nil {
		g.unhandled(d, reports)
		if wait {
			g.orphanReplies = append(g.orphanReplies, d)
		}
		return nil
	}
	d.script.queue = append(d.script.queue, workItem{delivery: d})
	if to.Up {
		label = d.script.name
	}
	fields := map[string]string{"to": label, "message": message}
	if d.function != nil {
		delete(fields, "message")
		fields["fn"] = Value{*d.function}.String()
	}
	if len(d.message.Args) > 0 {
		fields["args"] = argsDisplay(d.message.Args)
	}
	if wait {
		fields["wait"] = "yes"
		if x.run.Join != nil {
			fields["wait"] = "join"
		}
	}
	g.record("send", false, []string{string(d.from)}, fields)
	if d.script.stopped {
		if g.stoppedSends == nil {
			g.stoppedSends = map[*Script]bool{}
		}
		g.stoppedSends[d.script] = true
	}
	return nil
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
	if o := x.delivery.message.Limits; o != nil && (o.MaxWait > 0 || o.Set&OverrideMaxWait != 0) {
		return min(o.MaxWait, x.delivery.script.limits.MaxWait)
	}
	return x.delivery.script.limits.MaxWait
}
