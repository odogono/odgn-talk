package northtalk

import (
	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
)

// nearestOwner reads the current path. The caller holds g.mu.
func (g *Group) nearestOwner(o *Object) *Script {
	for ; o != nil; o = o.parent {
		if !o.disposed.Load() && o.owner != nil && !o.owner.stopped {
			return o.owner
		}
	}
	return nil
}
func (d delivery) targetValue() corevalue.Value {
	if d.target == nil {
		return corevalue.Value{}
	}
	return d.target.Value().inner
}
func (g *Group) pathReceiver(d delivery) *Script {
	root := d.target
	if d.after != nil {
		root = d.after.parent
	}
	return g.nearestOwner(root)
}

// moveDelivery transfers an existing admission, without a capacity check or
// execution charge. It runs before observation or Run creation.
func (g *Group) moveDelivery(d delivery) (delivery, bool) {
	if !d.path {
		return d, false
	}
	g.mu.Lock()
	s := g.pathReceiver(d)
	if s == d.script {
		g.mu.Unlock()
		return d, false
	}
	if d.script != nil {
		d.script.reserved--
	}
	if s != nil {
		s.reserved++
	}
	g.mu.Unlock()
	d.script = s
	if s != nil {
		s.queue = append(s.queue, workItem{delivery: d})
	}
	return d, true
}

// A climb is a new mailbox admission. Its queued route is anchored to the
// previous owner so subsequent movement cannot restart at the original target.
func (g *Group) climb(x *execution) bool {
	d := x.delivery
	if d.broadcast != "" || d.script.owner == nil {
		return false
	}
	d.path, d.after = true, d.script.owner
	g.mu.Lock()
	s := g.pathReceiver(d)
	full := s != nil && s.reserved >= s.limits.MailboxDepth
	if s != nil && !full {
		s.reserved++
	}
	g.mu.Unlock()
	if full {
		g.record("note", false, []string{string(x.id)}, map[string]string{"kind": "climb-full"})
		return false
	}
	if s == nil {
		return false
	}
	d.script = s
	s.queue = append(s.queue, workItem{delivery: d})
	return true
}
func (g *Group) unhandled(d delivery, reports *[]Report) {
	if d.broadcast != "" {
		return
	}
	*reports = append(*reports, &Unhandled{Delivery: d.id, Message: d.message, Target: d.target})
	fields := map[string]string{"message": d.message.Name}
	if len(d.message.Args) > 0 {
		fields["args"] = argsDisplay(d.message.Args)
	}
	if d.target != nil {
		fields["target"] = d.target.Value().String()
	}
	var ids []string
	if d.id != "" {
		ids = []string{string(d.id)}
	}
	g.record("unhandled", false, ids, fields)
}
