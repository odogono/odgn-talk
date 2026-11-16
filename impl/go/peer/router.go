// Package peer is a Host's Peer Router (chapter 9, The peer router; ADR
// 0181): it holds the Peer Exposures of every Group attached to it, carries
// Remote Sends between them as `post` Deliveries and `call` Requests, at
// most once, and withdraws Peer Exposures over their Lifetime. Its Release
// method is the `peer` Grant release hook.
//
//	router := peer.New(core, peer.Options{})
//	def, _ := core.PeerCapability(router, costs)
//	router.Attach(group, identity)
//
// Links carry Remote Sends to other Hosts: Connect one, or give Options.Dial.
package peer

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"regexp"
	"slices"
	"sync"

	talk "northtalk.org/go"
)

// Binding is a `peer` Grant's binding: the names it may expose and reach. A
// nil list allows any name; a name outside a list is `bad address`.
type Binding struct {
	Expose, Reach []string
}

// Options configure a Router.
type Options struct {
	// Key is this Host's key fingerprint, 64 lowercase hex digits, which
	// every Peer id begins with. Empty makes a random one.
	Key string
	// Dial is a link to the Host an address names, or nil when there is
	// none. A Router with Dial reaches every address through it, by asking
	// that Host; one without reaches the names its own Groups expose. It may
	// block, and is never called with the router's lock held.
	Dial func(address string) Link
	// AddressOf is the address Dial takes for the Host with a key, for a
	// Peer naming a key with no open link.
	AddressOf func(key string) (string, bool)
}

// Router holds a Host's Peer Exposures and carries Remote Sends between the
// Groups attached to it. It is a talk.PeerImpl with a Release hook.
type Router struct {
	o         Options
	key       string
	kind      *talk.ObjectKind
	mu        sync.Mutex
	exposures map[string]exposure // by secret
	names     map[string]string   // to a secret
	members   map[target]*member
	wires     map[string]*wire // by the other Host's key
	addressed map[string]*wire // by the address dialled
	outboxes  map[string]chan func(*wire)
}

var _ talk.PeerImpl = (*Router)(nil)

// New makes a Router whose Peers are of core's `peer` Object Kind.
func New(core *talk.Core, o Options) *Router {
	key := o.Key
	if key == "" {
		b := make([]byte, 32)
		_, _ = rand.Read(b)
		key = hex.EncodeToString(b)
	}
	r := newRouter(key, core.PeerKind())
	r.o = o
	return r
}

func newRouter(key string, kind *talk.ObjectKind) *Router {
	return &Router{key: key, kind: kind, exposures: map[string]exposure{},
		names: map[string]string{}, members: map[target]*member{},
		wires: map[string]*wire{}, addressed: map[string]*wire{}, outboxes: map[string]chan func(*wire){}}
}

// Key is this Host's key fingerprint, as every Peer id names it.
func (r *Router) Key() string { return r.key }

// Attach lets group's Scripts expose and send through the router, as
// senders vouched for by identity, such as {group: "shop"}.
func (r *Router) Attach(group *talk.Group, identity talk.Value) {
	r.attach(groupTarget{group, r.kind}, identity)
}

// Detach is for a Group the Host discards: it withdraws every Peer Exposure
// its Scripts made, and forgets its Peers and Caller Identities.
func (r *Router) Detach(group *talk.Group) {
	r.detach(groupTarget{group, r.kind})
}

// The talk.PeerImpl, and the release hook.

func (r *Router) Expose(c *talk.Call, name string) error { return r.expose(callOf(c, r.kind), name) }

func (r *Router) Unexpose(c *talk.Call, name string, peer *talk.Object) error {
	id := ""
	if peer != nil {
		id = peer.ID()
	}
	r.unexpose(callOf(c, r.kind), name, id)
	return nil
}

func (r *Router) Reach(c *talk.Call, address string) error {
	return r.reach(callOf(c, r.kind), address)
}

func (r *Router) Post(c *talk.Call, peer *talk.Object, message string, args []talk.Value) error {
	return r.send(callOf(c, r.kind), peer.ID(), message, args, false)
}

func (r *Router) Call(c *talk.Call, peer *talk.Object, message string, args []talk.Value) error {
	return r.send(callOf(c, r.kind), peer.ID(), message, args, true)
}

// Caller gives the Caller Identity this Host vouched for the Delivery that
// started the calling Run, or Nothing.
func (r *Router) Caller(c *talk.Call) (talk.Value, error) {
	return r.caller(callOf(c, r.kind)), nil
}

// Release withdraws the Peer Exposures the released Grant made, named and
// unnamed, for a release by `stop`, `revoke` or `disable`. A Reload keeps
// them, since the Script goes on (chapter 9, The peer router: Lifetime).
func (r *Router) Release(ctx talk.GrantContext) {
	r.release(owner{groupTarget{ctx.Group, r.kind}, ctx.ScriptName, ctx.GrantName}, ctx.Reason)
}

// ---------------------------------------------------------------- the seam

// target is a Group as the router uses it. A *talk.Group is one through
// groupTarget; the peer kit uses stand-ins.
type target interface {
	// peer makes the Group's Peer for an exposure id.
	peer(id string) (talk.Value, error)
	deliver(script string, m talk.Message) (talk.DeliveryID, error)
	// request gives the Request's delivery id, and settled, which calls back
	// once with its result when it settles.
	request(script string, m talk.Message) (talk.DeliveryID, func(func(talk.Value, *talk.ScriptError)), error)
}

// errNoScript is a target's refusal for a Script it doesn't have.
var errNoScript = errors.New("no such Script")

// groupTarget is comparable, so equal Groups are one map key.
type groupTarget struct {
	g    *talk.Group
	kind *talk.ObjectKind
}

func (t groupTarget) peer(id string) (talk.Value, error) {
	if p, found := t.g.ObjectByID("peer", id); found && p != nil {
		return p.Value(), nil
	}
	p, err := t.g.Object(t.kind, id, nil)
	if err != nil {
		return talk.Nothing, err
	}
	return p.Value(), nil
}

func (t groupTarget) deliver(script string, m talk.Message) (talk.DeliveryID, error) {
	s := t.g.Script(script)
	if s == nil {
		return "", errNoScript
	}
	return s.Deliver(m)
}

func (t groupTarget) request(script string, m talk.Message) (talk.DeliveryID, func(func(talk.Value, *talk.ScriptError)), error) {
	s := t.g.Script(script)
	if s == nil {
		return "", nil, errNoScript
	}
	id, pending, err := s.Request(context.Background(), m)
	if err != nil {
		return "", nil, err
	}
	return id, func(then func(talk.Value, *talk.ScriptError)) {
		go func() {
			<-pending.Done()
			then(pending.Result())
		}()
	}, nil
}

// owner is chapter 7's: the Group, Script and named Grant that exposed it.
type owner struct {
	group  target
	script string
	grant  string
}

type exposure struct {
	owner owner
	name  string
}

type member struct {
	// identity is what this Host vouches for about a sender in this Group.
	identity talk.Value
	// callers holds each Remote Send's sender, by the delivery id it got here.
	callers map[string]talk.Value
	// peers holds this Group's one Peer for each exposure, by its id.
	peers map[string]talk.Value
}

// call is a Call as the router uses it.
type call struct {
	owner
	binding  any
	delivery string
	answer   func(talk.Value)
	fail     func(*talk.ScriptError)
}

func callOf(c *talk.Call, kind *talk.ObjectKind) call {
	return call{owner: owner{groupTarget{c.Group(), kind}, c.ScriptName(), c.GrantName()},
		binding: c.Binding(), delivery: c.Delivery(), answer: c.Answer, fail: c.Fail}
}

// ---------------------------------------------------------------- the router

func failure(code string, pairs ...talk.Pair) *talk.ScriptError {
	data, _ := talk.Map(pairs...)
	return &talk.ScriptError{Code: code, Message: code, Data: data}
}

func sendFailed(reason string) *talk.ScriptError {
	t, _ := talk.Text(reason)
	return failure("send failed", talk.Pair{Key: "reason", Val: t})
}

// secret is 128 random bits, so no one guesses an exposure into existence.
func secret() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

var peerID = regexp.MustCompile(`^([0-9a-f]{64})/([0-9a-f]{32})$`)

// mine is the secret of a Peer id naming this Host's key.
func (r *Router) mine(id string) (string, bool) {
	m := peerID.FindStringSubmatch(id)
	if m == nil || m[1] != r.key {
		return "", false
	}
	return m[2], true
}

func (r *Router) attach(t target, identity talk.Value) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.members[t] = &member{identity: identity, callers: map[string]talk.Value{}, peers: map[string]talk.Value{}}
}

func (r *Router) detach(t target) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.withdrawWhere(func(o owner) bool { return o.group == t })
	delete(r.members, t)
}

func (r *Router) release(o owner, reason talk.ReleaseReason) {
	if reason == talk.ReleaseReload {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.withdrawWhere(func(held owner) bool { return held == o })
}

// withdrawWhere withdraws each exposure whose owner matches, freeing its
// name. The caller holds mu.
func (r *Router) withdrawWhere(match func(owner) bool) {
	for key, e := range r.exposures {
		if !match(e.owner) {
			continue
		}
		delete(r.exposures, key)
		if e.name != "" && r.names[e.name] == key {
			delete(r.names, e.name)
		}
	}
}

// peerIn is the Group's one Peer for this Host's exposure. The caller
// holds mu.
func (r *Router) peerIn(t target, secret string) (talk.Value, error) {
	return r.peerOf(t, r.key+"/"+secret)
}

// peerOf is the Group's one Peer for an exposure id, on this Host or
// another, made the first time. The caller holds mu.
func (r *Router) peerOf(t target, id string) (talk.Value, error) {
	m := r.members[t]
	if m == nil {
		return talk.Nothing, errors.New("peer: the Group isn't attached")
	}
	if p, ok := m.peers[id]; ok {
		return p, nil
	}
	p, err := t.peer(id)
	if err != nil {
		return talk.Nothing, err
	}
	m.peers[id] = p
	return p, nil
}

func allows(c call, names func(Binding) []string, name string) bool {
	b, _ := c.binding.(Binding)
	return names(b) == nil || slices.Contains(names(b), name)
}

func (r *Router) answerPeer(c call, secret string) error {
	p, err := r.peerIn(c.group, secret)
	if err != nil {
		return err
	}
	c.answer(p)
	return nil
}

func (r *Router) expose(c call, name string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if name != "" && !allows(c, func(b Binding) []string { return b.Expose }, name) {
		c.fail(failure("bad address"))
		return nil
	}
	if key, held := r.names[name]; name != "" && held {
		if r.exposures[key].owner != c.owner {
			c.fail(failure("name in use"))
			return nil
		}
		return r.answerPeer(c, key)
	}
	key := secret()
	r.exposures[key] = exposure{owner: c.owner, name: name}
	if name != "" {
		r.names[name] = key
	}
	return r.answerPeer(c, key)
}

func (r *Router) unexpose(c call, name, id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	key, held := r.names[name]
	if id != "" {
		key, held = r.mine(id)
	}
	if !held || r.exposures[key].owner != c.owner {
		return
	}
	e := r.exposures[key]
	delete(r.exposures, key)
	if e.name != "" && r.names[e.name] == key {
		delete(r.names, e.name)
	}
}

func (r *Router) reach(c call, address string) error {
	if !allows(c, func(b Binding) []string { return b.Reach }, address) {
		c.fail(failure("bad address"))
		return nil
	}
	if r.o.Dial != nil {
		r.reachAway(c, address)
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	key, held := r.names[address]
	if !held {
		c.fail(failure("not exposed"))
		return nil
	}
	return r.answerPeer(c, key)
}

// cross is a value as the receiving Group reads it: each Peer becomes that
// Group's Peer for the same exposure. The Core refuses other Host Objects
// and Function Values at the send, but a reply may hold one: ok is false.
// The caller holds mu.
func (r *Router) cross(v talk.Value, to target) (talk.Value, bool) {
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
		if !peerID.MatchString(o.ID()) || o.Kind() != r.kind {
			return talk.Nothing, false
		}
		p, err := r.peerOf(to, o.ID())
		return p, err == nil
	case talk.KindFunction:
		return talk.Nothing, false
	}
	return v, true
}

func (r *Router) crossAll(args []talk.Value, to target) ([]talk.Value, bool) {
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

// vouch records the sender for the delivery it got: its Group's identity,
// never a claim in the arguments. The caller holds mu.
func (r *Router) vouch(from, to target, id talk.DeliveryID) {
	identity := talk.Nothing
	if m := r.members[from]; m != nil {
		identity = m.identity
	}
	if m := r.members[to]; m != nil {
		m.callers[string(id)] = identity
	}
}

// send carries a Remote Send to the exposure a Peer id names. A `post` never
// fails in the Script: one that can't go is dropped.
func (r *Router) send(c call, id, message string, args []talk.Value, waits bool) error {
	fail := func(reason string) {
		if waits {
			c.fail(sendFailed(reason))
		}
	}
	key, mine := r.mine(id)
	if !mine {
		if m := peerID.FindStringSubmatch(id); m != nil {
			r.sendAway(c, m[1], id, message, args, waits)
		} else {
			fail("unreachable")
		}
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	e, held := r.exposures[key]
	if !held || r.members[e.owner.group] == nil {
		fail("not exposed")
		return nil
	}
	to := e.owner.group
	sent, ok := r.crossAll(args, to)
	if !ok {
		fail("unreachable")
		return nil
	}
	m := talk.Message{Name: message, Args: sent}
	if !waits {
		if delivered, err := to.deliver(e.owner.script, m); err == nil {
			r.vouch(c.group, to, delivered)
		}
		return nil
	}
	delivered, settled, err := to.request(e.owner.script, m)
	switch {
	case errors.Is(err, talk.ErrMailboxFull):
		fail("mailbox full")
		return nil
	case errors.Is(err, errNoScript):
		fail("not exposed")
		return nil
	case err != nil:
		fail("unreachable")
		return nil
	}
	r.vouch(c.group, to, delivered)
	from := c.group
	// Delivered once; an abandoned call's reply is dropped when it comes.
	settled(func(reply talk.Value, failed *talk.ScriptError) {
		if failed != nil {
			if failed.Code == "send failed" {
				c.fail(failure("send failed", failed.Data.Entries()...))
			} else {
				c.fail(sendFailed("unreachable"))
			}
			return
		}
		r.mu.Lock()
		back, ok := r.cross(reply, from)
		r.mu.Unlock()
		if !ok {
			c.fail(sendFailed("unreachable"))
			return
		}
		c.answer(back)
	})
	return nil
}

func (r *Router) caller(c call) talk.Value {
	r.mu.Lock()
	defer r.mu.Unlock()
	if m := r.members[c.group]; m != nil && c.delivery != "" {
		if v, ok := m.callers[c.delivery]; ok {
			return v
		}
	}
	return talk.Nothing
}
