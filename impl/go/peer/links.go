package peer

// Remote Sends to other Hosts (chapter 12's Runner peers, ADR 0165): the
// router speaks the `reach`, `post` and `call` frames, in the Value
// Encoding, over Links. A Link only moves whole frames and says which Host
// is at the other end; how it does that, such as mutual TLS, is the Host's.

import (
	"errors"
	"strconv"
	"sync"

	talk "northtalk.org/go"
	corevalue "northtalk.org/go/internal/value"
)

// Link is one connection to another Host.
type Link interface {
	// Key is the other Host's key fingerprint.
	Key() string
	// Identity is the Caller Identity for what arrives on the link: what this
	// Host vouches for about the other one, or Nothing when it vouches for
	// nobody.
	Identity() talk.Value
	// Run hands each whole frame that arrives to arrive, in order, and
	// returns when the link closes.
	Run(arrive func(frame []byte))
	// Send sends one whole frame; false when it can't, as when closed or too
	// large.
	Send(frame []byte) bool
	Close()
}

// wire is a Link the router has connected, with the questions it waits on.
type wire struct {
	link   Link
	mu     sync.Mutex
	next   int
	asked  map[int]func(frame []byte, ok bool)
	closed bool
}

func (w *wire) send(frame talk.Value) bool {
	body, err := talk.EncodeValue(frame)
	if err != nil {
		return false
	}
	w.mu.Lock()
	closed := w.closed
	w.mu.Unlock()
	return !closed && w.link.Send(body)
}

// ask sends a question; answer hears its answer's frame, or ok false when
// the link closes first.
func (w *wire) ask(kind string, answer func(frame []byte, ok bool), rest ...talk.Pair) {
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		answer(nil, false)
		return
	}
	w.next++
	n := w.next
	w.asked[n] = answer
	w.mu.Unlock()
	frame, _ := talk.Map(append([]talk.Pair{{Key: kind, Val: talk.Int(int64(n))}}, rest...)...)
	if !w.send(frame) {
		w.mu.Lock()
		delete(w.asked, n)
		w.mu.Unlock()
		answer(nil, false)
	}
}

func (w *wire) answered(n int, frame []byte) {
	w.mu.Lock()
	answer := w.asked[n]
	delete(w.asked, n)
	w.mu.Unlock()
	if answer != nil {
		answer(frame, true)
	}
}

func (w *wire) isClosed() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.closed
}

func (w *wire) close() {
	w.mu.Lock()
	w.closed = true
	waiting := w.asked
	w.asked = map[int]func([]byte, bool){}
	w.mu.Unlock()
	for _, answer := range waiting {
		answer(nil, false)
	}
}

// Connect carries Remote Sends over a link. The newest link to a key carries
// what this Host sends there.
func (r *Router) Connect(l Link) {
	r.connect(l, "")
}

func (r *Router) connect(l Link, address string) *wire {
	w := &wire{link: l, asked: map[int]func([]byte, bool){}}
	r.mu.Lock()
	r.wires[l.Key()] = w
	if address != "" {
		r.addressed[address] = w
	}
	r.mu.Unlock()
	go func() {
		l.Run(func(frame []byte) { r.arrive(w, frame) })
		w.close()
		r.mu.Lock()
		if r.wires[l.Key()] == w {
			delete(r.wires, l.Key())
		}
		for a, held := range r.addressed {
			if held == w {
				delete(r.addressed, a)
			}
		}
		r.mu.Unlock()
	}()
	return w
}

// Close closes every link.
func (r *Router) Close() {
	r.mu.Lock()
	wires := make([]*wire, 0, len(r.wires))
	for _, w := range r.wires {
		wires = append(wires, w)
	}
	for _, w := range r.addressed {
		wires = append(wires, w)
	}
	r.mu.Unlock()
	for _, w := range wires {
		w.link.Close()
	}
}

// dialled is the open wire for an address, or a new one from Options.Dial;
// nil when there is none.
func (r *Router) dialled(address string) *wire {
	r.mu.Lock()
	open := r.addressed[address]
	r.mu.Unlock()
	if open != nil && !open.isClosed() {
		return open
	}
	if r.o.Dial == nil {
		return nil
	}
	l := r.o.Dial(address)
	if l == nil {
		return nil
	}
	return r.connect(l, address)
}

// wireTo is a wire to the Host with this key, dialled if Options.AddressOf
// gives its address.
func (r *Router) wireTo(key string) *wire {
	r.mu.Lock()
	open := r.wires[key]
	r.mu.Unlock()
	if open != nil && !open.isClosed() {
		return open
	}
	if r.o.AddressOf == nil {
		return nil
	}
	address, ok := r.o.AddressOf(key)
	if !ok {
		return nil
	}
	w := r.dialled(address)
	if w == nil || w.link.Key() != key {
		return nil
	}
	return w
}

// enqueue runs job with a wire to the Host with this key, after every job
// queued for that Host before it, so Remote Sends leave in the order the
// Scripts made them.
func (r *Router) enqueue(key string, job func(*wire)) {
	r.mu.Lock()
	box := r.outboxes[key]
	if box == nil {
		box = make(chan func(*wire), 1024)
		r.outboxes[key] = box
		go func() {
			for job := range box {
				job(r.wireTo(key))
			}
		}()
	}
	r.mu.Unlock()
	box <- job
}

// ---------------------------------------------------------------- frames

// header is a frame's own fields, read without resolving the Peers in it.
type header struct{ v corevalue.Value }

func peek(frame []byte) (header, bool) {
	v, err := corevalue.Decode(frame, true, func(string, string) (corevalue.Value, error) {
		return corevalue.Value{}, nil
	})
	return header{v}, err == nil && v.Kind == corevalue.Map
}

func (h header) has(key string) bool {
	for _, p := range h.v.Entries() {
		if p.Key == key {
			return true
		}
	}
	return false
}

func (h header) text(key string) string { return h.v.Get(key).Text() }

func (h header) whole(key string) (int, bool) {
	if !h.has(key) || h.v.Get(key).Kind != corevalue.Number {
		return 0, false
	}
	n, err := strconv.Atoi(h.v.Get(key).Number().String())
	return n, err == nil
}

func text(s string) talk.Value { t, _ := talk.Text(s); return t }

// decode reads a frame against the Group that receives it: each Peer in it
// becomes that Group's Peer for the same exposure.
func (r *Router) decode(frame []byte, to target) (talk.Value, bool) {
	v, err := talk.DecodeValue(frame, func(kind, id string) (*talk.Object, bool) {
		if kind != "peer" || !peerID.MatchString(id) {
			return nil, false
		}
		r.mu.Lock()
		p, err := r.peerOf(to, id)
		r.mu.Unlock()
		if err != nil {
			return nil, false
		}
		return p.AsObject()
	})
	return v, err == nil
}

func items(v talk.Value) []talk.Value {
	out := make([]talk.Value, v.Len())
	for i := range out {
		out[i] = v.Index(i + 1)
	}
	return out
}

// arrive handles one frame from another Host.
func (r *Router) arrive(w *wire, frame []byte) {
	h, ok := peek(frame)
	if !ok {
		w.link.Close()
		return
	}
	if n, ok := h.whole("reached"); ok {
		w.answered(n, frame)
		return
	}
	if n, ok := h.whole("replied"); ok {
		w.answered(n, frame)
		return
	}
	if n, ok := h.whole("reach"); ok {
		r.mu.Lock()
		key, named := r.names[h.text("name")]
		r.mu.Unlock()
		answer := talk.Pair{Key: "error", Val: text("not exposed")}
		if named {
			answer = talk.Pair{Key: "peer", Val: text(r.key + "/" + key)}
		}
		reply, _ := talk.Map(talk.Pair{Key: "reached", Val: talk.Int(int64(n))}, answer)
		w.send(reply)
		return
	}
	if h.has("post") {
		r.arriving(w, frame, h.text("post"), false, nil)
		return
	}
	n, ok := h.whole("call")
	if !ok {
		return
	}
	reply := func(p talk.Pair) {
		v, _ := talk.Map(talk.Pair{Key: "replied", Val: talk.Int(int64(n))}, p)
		w.send(v)
	}
	r.arriving(w, frame, h.text("to"), true, func(value talk.Value, failed *talk.ScriptError) {
		if failed == nil {
			// A reply that can't be encoded, as one holding a Function Value,
			// can't come back.
			if v, err := talk.Map(talk.Pair{Key: "replied", Val: talk.Int(int64(n))}, talk.Pair{Key: "value", Val: value}); err != nil || !w.send(v) {
				failed = sendFailed("unreachable")
			} else {
				return
			}
		}
		reply(talk.Pair{Key: "failed", Val: failed.Data})
	})
}

// arriving gives a Remote Send from another Host to this Host's exposure:
// a Delivery, or for a call a Request whose settling answers it.
func (r *Router) arriving(w *wire, frame []byte, to string, waits bool, answer func(talk.Value, *talk.ScriptError)) {
	fail := func(reason string) {
		if waits {
			answer(talk.Nothing, sendFailed(reason))
		}
	}
	r.mu.Lock()
	key, mine := r.mine(to)
	e, held := r.exposures[key]
	attached := held && r.members[e.owner.group] != nil
	r.mu.Unlock()
	if !mine || !attached {
		fail("not exposed")
		return
	}
	decoded, ok := r.decode(frame, e.owner.group)
	if !ok {
		w.link.Close()
		return
	}
	name, _ := decoded.Get("message").AsText()
	m := talk.Message{Name: name, Args: items(decoded.Get("args"))}
	identity := w.link.Identity()
	if !waits {
		if id, err := e.owner.group.deliver(e.owner.script, m); err == nil {
			r.record(e.owner.group, id, identity)
		}
		return
	}
	id, settled, err := e.owner.group.request(e.owner.script, m)
	switch {
	case err == nil:
	case errors.Is(err, talk.ErrMailboxFull):
		fail("mailbox full")
		return
	case errors.Is(err, errNoScript):
		fail("not exposed")
		return
	default:
		fail("unreachable")
		return
	}
	r.record(e.owner.group, id, identity)
	settled(func(value talk.Value, failed *talk.ScriptError) {
		if failed != nil && failed.Code != "send failed" {
			failed = sendFailed("unreachable")
		}
		answer(value, failed)
	})
}

// record keeps a Remote Send's Caller Identity by the delivery id it got.
func (r *Router) record(to target, id talk.DeliveryID, identity talk.Value) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if m := r.members[to]; m != nil {
		m.callers[string(id)] = identity
	}
}

// sendAway carries a Remote Send to another Host's exposure, in order behind
// the ones made before it.
func (r *Router) sendAway(c call, key, id, message string, args []talk.Value, waits bool) {
	rest := []talk.Pair{{Key: "message", Val: text(message)}, {Key: "args", Val: talk.List(args...)}}
	r.enqueue(key, func(w *wire) {
		if !waits {
			if w != nil {
				frame, _ := talk.Map(append([]talk.Pair{{Key: "post", Val: text(id)}}, rest...)...)
				w.send(frame)
			}
			return
		}
		if w == nil {
			c.fail(sendFailed("unreachable"))
			return
		}
		w.ask("call", func(frame []byte, ok bool) {
			if !ok {
				c.fail(sendFailed("unreachable"))
				return
			}
			v, decoded := r.decode(frame, c.group)
			h, _ := peek(frame)
			switch {
			case decoded && h.has("value"):
				c.answer(v.Get("value"))
			case h.has("failed"):
				failed := h.v.Get("failed")
				pairs := []talk.Pair{{Key: "reason", Val: text(failed.Get("reason").Text())}}
				if decoded {
					if e := v.Get("failed").Get("error"); e.Kind() != talk.KindNothing {
						pairs = append(pairs, talk.Pair{Key: "error", Val: e})
					}
				}
				c.fail(failure("send failed", pairs...))
			default:
				c.fail(sendFailed("unreachable"))
			}
		}, append([]talk.Pair{{Key: "to", Val: text(id)}}, rest...)...)
	})
}

// reachAway asks the Host at address for the exposure it names.
func (r *Router) reachAway(c call, address string) {
	go func() {
		w := r.dialled(address)
		if w == nil {
			c.fail(failure("bad address"))
			return
		}
		w.ask("reach", func(frame []byte, ok bool) {
			if !ok {
				c.fail(failure("bad address"))
				return
			}
			h, _ := peek(frame)
			id := h.text("peer")
			m := peerID.FindStringSubmatch(id)
			if m == nil || m[1] != w.link.Key() {
				c.fail(failure("not exposed"))
				return
			}
			r.mu.Lock()
			p, err := r.peerOf(c.group, id)
			r.mu.Unlock()
			if err != nil {
				c.fail(failure("bad address"))
				return
			}
			c.answer(p)
		}, talk.Pair{Key: "name", Val: text(address)})
	}()
}
