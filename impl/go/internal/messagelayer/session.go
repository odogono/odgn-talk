// Package messagelayer is the Message Layer over the Go embedding interface
// (spec/09-embedding.md#the-message-layer): one JSON message per embedding
// call, with a reply. The framing is the transport's; a Session takes and
// gives whole frames.
//
// Host code runs through interim replies. A worker call that may reach the
// Host, such as pump, runs on its own goroutine; each Operation or property
// callback hands a need back to Send and parks until the Host's matching
// result arrives in the next Send. So the Core never calls the Host, and under
// wasip1 no export waits on one.
package messagelayer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"

	talk "github.com/odogono/odgn-talk/impl/go"
)

// Protocol is the Message Layer protocol version that hello accepts.
const Protocol = 1

type Session struct {
	core   *talk.Core
	caps   map[string]*talk.CapabilityDef
	kinds  map[string]*talk.ObjectKind
	grants map[int64]*talk.Grant
	groups map[string]*group
	// waiting is the worker call parked on the Host, or nil.
	waiting *exchange
}

type group struct {
	g     *talk.Group
	trace *traceBuffer // nil: the Group records no Trace
	calls map[talk.CallID]*talk.Call
	// requests holds the Requests the Host may still cancel.
	requests map[talk.DeliveryID]request
}

type request struct {
	pending *talk.Pending
	cancel  context.CancelFunc
}

// exchange is one worker call that has gone to its own goroutine.
type exchange struct {
	ref     int64
	group   *group
	out     chan outFrame
	results chan fields
}

type outFrame struct {
	frame []byte
	final bool
}

func NewSession() *Session {
	return &Session{core: talk.New(), caps: map[string]*talk.CapabilityDef{}, kinds: map[string]*talk.ObjectKind{}, grants: map[int64]*talk.Grant{}, groups: map[string]*group{}}
}

// Send takes one message frame and returns its reply frame: a final reply, or
// a need that the Host answers with the matching result message.
func (s *Session) Send(frame []byte) []byte {
	var f fields
	if err := json.Unmarshal(frame, &f); err != nil {
		return replyFrame(-1, nil, protocolErrorf("malformed frame: %v", err))
	}
	ref, err := f.int("ref")
	if err != nil {
		return replyFrame(-1, nil, err)
	}
	name, err := f.str("m")
	if err != nil {
		return replyFrame(ref, nil, err)
	}
	if x := s.waiting; x != nil {
		if ref != x.ref {
			return replyFrame(ref, nil, protocolErrorf("ref %d is waiting on the Host's result", x.ref))
		}
		if name != "op-result" && name != "prop-result" {
			return replyFrame(ref, nil, protocolErrorf("%s sent while ref %d waits on a result", name, x.ref))
		}
		x.results <- f
		return s.await(x)
	}
	if name == "pump" {
		return s.pump(ref, f)
	}
	ok, err := s.call(name, f)
	return replyFrame(ref, ok, err)
}

func (s *Session) await(x *exchange) []byte {
	o := <-x.out
	if o.final {
		s.waiting = nil
	}
	return o.frame
}

// ask hands need to the Host and parks the worker call's goroutine until the
// Host's result arrives.
func (s *Session) ask(need map[string]any) fields {
	x := s.waiting
	x.out <- outFrame{frame: mustMarshal(map[string]any{"ref": x.ref, "need": need})}
	return <-x.results
}

func (s *Session) call(name string, f fields) (ok map[string]any, err error) {
	defer func() {
		if r := recover(); r != nil {
			ok, err = nil, recovered(r)
		}
	}()
	handle, found := handlers[name]
	if !found {
		if unsupported[name] {
			return nil, protocolErrorf("%s isn't carried by this Message Layer yet", name)
		}
		return nil, protocolErrorf("unknown message %q", name)
	}
	return handle(s, f)
}

// recovered turns a panic in the Core or a Host callback into a reply, so a
// fault never leaves the instance or the transport behind.
func recovered(r any) error {
	if e, ok := r.(error); ok {
		var host *talk.HostError
		if errors.As(e, &host) {
			return host
		}
		return protocolErrorf("Core panic: %v", e)
	}
	return protocolErrorf("Core panic: %v", r)
}

type protocolError struct{ detail string }

func (e *protocolError) Error() string { return e.detail }

func protocolErrorf(format string, args ...any) error {
	return &protocolError{fmt.Sprintf(format, args...)}
}

func replyFrame(ref int64, ok map[string]any, err error) []byte {
	if err != nil {
		return mustMarshal(map[string]any{"ref": ref, "err": errorForm(err)})
	}
	if ok == nil {
		ok = map[string]any{}
	}
	return mustMarshal(map[string]any{"ref": ref, "ok": ok})
}

func errorForm(err error) map[string]any {
	var traced *tracedError
	if errors.As(err, &traced) {
		out := errorForm(traced.error)
		out["trace"] = traced.trace
		return out
	}
	var host *talk.HostError
	var load *talk.LoadError
	var protocol *protocolError
	switch {
	case errors.As(err, &host):
		out := map[string]any{"kind": "host error", "code": string(host.Code)}
		if host.Detail != "" {
			out["detail"] = host.Detail
		}
		return out
	case errors.As(err, &load):
		diagnostics := []any{}
		for _, d := range load.Diagnostics {
			diagnostics = append(diagnostics, map[string]any{"code": d.Code, "message": d.Message, "unit": d.Unit, "line": d.Line, "col": d.Col})
		}
		return map[string]any{"kind": "load error", "diagnostics": diagnostics}
	case errors.Is(err, talk.ErrMailboxFull):
		return map[string]any{"kind": "mailbox full"}
	case errors.As(err, &protocol):
		return map[string]any{"kind": "protocol error", "detail": protocol.detail}
	}
	return map[string]any{"kind": "protocol error", "detail": err.Error()}
}

func mustMarshal(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		b, _ = json.Marshal(map[string]any{"ref": -1, "err": map[string]any{"kind": "protocol error", "detail": err.Error()}})
	}
	return b
}

// integer writes n as the Message Layer does: a JSON integer below 2⁵³ in
// magnitude, and its decimal text otherwise.
func integer(n int64) any {
	if n > -(1<<53) && n < 1<<53 {
		return n
	}
	return strconv.FormatInt(n, 10)
}
