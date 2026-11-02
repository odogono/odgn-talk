// Package peers is an in-process peer router (chapter 9, The peer router):
// it holds the exposures of Groups on one Host and carries Remote Sends
// between them, as `post` Deliveries and `call` Requests, at most once.
package peers

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"slices"
	"sync"

	talk "northtalk.org/go"
)

// Binding is a Grant's binding: the names it may expose and reach. A nil
// list allows any name; a name outside a list is `bad address`.
type Binding struct {
	Expose, Reach []string
}

type exposure struct {
	group  *talk.Group
	script string
	name   string
}

type member struct {
	// identity is what this Host vouches for about a sender in this Group.
	identity talk.Value
	// callers holds each Remote Send's sender, by the delivery id it got here.
	callers map[string]talk.Value
	// peers holds this Group's one Peer for each exposure, by its secret.
	peers map[string]*talk.Object
}

// Router carries Remote Sends between the Groups attached to it.
type Router struct {
	core      *talk.Core
	mu        sync.Mutex
	exposures map[string]exposure
	names     map[string]string
	members   map[*talk.Group]*member
}

func New(core *talk.Core) *Router {
	return &Router{core: core, exposures: map[string]exposure{}, names: map[string]string{}, members: map[*talk.Group]*member{}}
}

// Attach lets group's Scripts use the router, as senders vouched for by
// identity, such as {group: "shop"}.
func (r *Router) Attach(group *talk.Group, identity talk.Value) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.members[group] = &member{identity: identity, callers: map[string]talk.Value{}, peers: map[string]*talk.Object{}}
}

// secret is 128 random bits, so no one guesses an exposure into existence.
func secret() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func failure(code string, pairs ...talk.Pair) *talk.ScriptError {
	data, _ := talk.Map(pairs...)
	return &talk.ScriptError{Code: code, Message: code, Data: data}
}

func sendFailed(reason string) *talk.ScriptError {
	t, _ := talk.Text(reason)
	return failure("send failed", talk.Pair{Key: "reason", Val: t})
}

// peerIn is the Group's one Peer for an exposure, made the first time.
func (r *Router) peerIn(group *talk.Group, key string) (*talk.Object, error) {
	m := r.members[group]
	if p := m.peers[key]; p != nil {
		return p, nil
	}
	p, err := group.Object(r.core.PeerKind(), key, nil)
	if err != nil {
		return nil, err
	}
	m.peers[key] = p
	return p, nil
}

func allows(c *talk.Call, names func(Binding) []string, name string) bool {
	b, _ := c.Binding().(Binding)
	return names(b) == nil || slices.Contains(names(b), name)
}

func (r *Router) answerPeer(c *talk.Call, key string) error {
	p, err := r.peerIn(c.Group(), key)
	if err != nil {
		return err
	}
	c.Answer(p.Value())
	return nil
}

func (r *Router) Expose(c *talk.Call, name string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if name != "" && !allows(c, func(b Binding) []string { return b.Expose }, name) {
		c.Fail(failure("bad address"))
		return nil
	}
	if key, held := r.names[name]; name != "" && held {
		e := r.exposures[key]
		if e.group != c.Group() || e.script != c.ScriptName() {
			c.Fail(failure("name in use"))
			return nil
		}
		return r.answerPeer(c, key)
	}
	key := secret()
	r.exposures[key] = exposure{group: c.Group(), script: c.ScriptName(), name: name}
	if name != "" {
		r.names[name] = key
	}
	return r.answerPeer(c, key)
}

func (r *Router) Unexpose(c *talk.Call, name string, peer *talk.Object) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	key := r.names[name]
	if peer != nil {
		key = peer.ID()
	}
	e, held := r.exposures[key]
	if !held || e.group != c.Group() || e.script != c.ScriptName() {
		return nil
	}
	delete(r.exposures, key)
	if e.name != "" {
		delete(r.names, e.name)
	}
	return nil
}

func (r *Router) Reach(c *talk.Call, address string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !allows(c, func(b Binding) []string { return b.Reach }, address) {
		c.Fail(failure("bad address"))
		return nil
	}
	key, held := r.names[address]
	if !held {
		c.Fail(failure("not exposed"))
		return nil
	}
	return r.answerPeer(c, key)
}

// cross is a value as the receiving Group reads it: each Peer becomes that
// Group's Peer for the same exposure. The Core refuses other Host Objects
// and Function Values at the send, but a reply may hold one: ok is false.
func (r *Router) cross(v talk.Value, to *talk.Group) (talk.Value, bool) {
	switch v.Kind() {
	case talk.KindList:
		items := make([]talk.Value, v.Len())
		for i := range items {
			x, ok := r.cross(v.Index(i+1), to)
			if !ok {
				return talk.Nothing, false
			}
			items[i] = x
		}
		return talk.List(items...), true
	case talk.KindMap:
		pairs := v.Entries()
		for i, p := range pairs {
			x, ok := r.cross(p.Val, to)
			if !ok {
				return talk.Nothing, false
			}
			pairs[i].Val = x
		}
		m, err := talk.Map(pairs...)
		return m, err == nil
	case talk.KindObject:
		o, _ := v.AsObject()
		if _, held := r.exposures[o.ID()]; !held || o.Kind() != r.core.PeerKind() {
			return talk.Nothing, false
		}
		p, err := r.peerIn(to, o.ID())
		if err != nil {
			return talk.Nothing, false
		}
		return p.Value(), true
	case talk.KindFunction:
		return talk.Nothing, false
	}
	return v, true
}

func (r *Router) crossAll(args []talk.Value, to *talk.Group) ([]talk.Value, bool) {
	out := make([]talk.Value, len(args))
	for i, a := range args {
		x, ok := r.cross(a, to)
		if !ok {
			return nil, false
		}
		out[i] = x
	}
	return out, true
}

// target is where a Remote Send to peer goes, if its exposure still stands.
func (r *Router) target(peer *talk.Object) (*talk.Group, *talk.Script) {
	e, held := r.exposures[peer.ID()]
	if !held {
		return nil, nil
	}
	s := e.group.Script(e.script)
	if s == nil {
		return nil, nil
	}
	return e.group, s
}

// vouch records the sender for the delivery it got: its Group's identity,
// never a claim in the arguments.
func (r *Router) vouch(c *talk.Call, to *talk.Group, id talk.DeliveryID) {
	r.members[to].callers[string(id)] = r.members[c.Group()].identity
}

// Post never fails in the Script: one that can't go is dropped.
func (r *Router) Post(c *talk.Call, peer *talk.Object, message string, args []talk.Value) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	group, s := r.target(peer)
	if s == nil {
		return nil
	}
	sent, ok := r.crossAll(args, group)
	if !ok {
		return nil
	}
	if id, err := s.Deliver(talk.Message{Name: message, Args: sent}); err == nil {
		r.vouch(c, group, id)
	}
	return nil
}

func (r *Router) Call(c *talk.Call, peer *talk.Object, message string, args []talk.Value) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	group, s := r.target(peer)
	if s == nil {
		c.Fail(sendFailed("not exposed"))
		return nil
	}
	sent, ok := r.crossAll(args, group)
	if !ok {
		c.Fail(sendFailed("unreachable"))
		return nil
	}
	id, pending, err := s.Request(context.Background(), talk.Message{Name: message, Args: sent})
	if err == talk.ErrMailboxFull {
		c.Fail(sendFailed("mailbox full"))
		return nil
	}
	if err != nil {
		return err
	}
	r.vouch(c, group, id)
	from := c.Group()
	// Delivered once; an abandoned call's reply is dropped when it comes.
	go func() {
		<-pending.Done()
		reply, failed := pending.Result()
		if failed != nil {
			if failed.Code == "send failed" {
				c.Fail(failure("send failed", failed.Data.Entries()...))
			} else {
				c.Fail(sendFailed("unreachable"))
			}
			return
		}
		r.mu.Lock()
		back, ok := r.cross(reply, from)
		r.mu.Unlock()
		if !ok {
			c.Fail(sendFailed("unreachable"))
			return
		}
		c.Answer(back)
	}()
	return nil
}

// Caller gives the Caller Identity this Host vouched for the Delivery that
// started the calling Run, or Nothing.
func (r *Router) Caller(c *talk.Call) (talk.Value, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if v, ok := r.members[c.Group()].callers[c.Delivery()]; ok && c.Delivery() != "" {
		return v, nil
	}
	return talk.Nothing, nil
}
