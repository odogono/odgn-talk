package northtalk

import (
	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
)

// A paid Script send joins the work queue immediately, never the Host input
// queue. Capacity includes accepted Host inputs, even during this Pump.
func (g *Group) send(x *execution, to, message string, args []corevalue.Value) bool {
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
	s.queue = append(s.queue, workItem{delivery: delivery{script: s, message: Message{Name: message, Args: vs}, from: x.id}})
	g.writeRaises(x, x.raisesWritten)
	fields := map[string]string{"to": to, "message": message}
	if len(vs) > 0 {
		fields["args"] = argsDisplay(vs)
	}
	g.record("send", false, []string{string(x.id)}, fields)
	return true
}
