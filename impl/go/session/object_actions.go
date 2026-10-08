package session

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	talk "github.com/odogono/odgn-talk/impl/go"
	"github.com/odogono/odgn-talk/impl/go/internal/sessionio"
	"time"
)

var actionFields = map[string][]string{
	"set-parent": {"kind", "object", "parent"}, "dispose": {"kind", "object"}, "deliver": {"kind", "to", "message"}, "request": {"kind", "to", "message"},
	"cancel-delivery": {"kind", "delivery"}, "broadcast": {"kind", "message"}, "call": {"kind", "fn", "args"}, "decide": {"kind", "message"},
	"answer": {"kind", "call", "value"}, "fail": {"kind", "call", "error"}, "settle": {"kind", "call", "settlement"}, "stop": {"kind", "script", "reason"}, "cancel-run": {"kind", "script", "run"}, "revoke": {"kind", "script", "grant"},
}

func validateRequest(e Envelope) {
	kind := envelopeText(e["kind"])
	fields, ok := actionFields[kind]
	if !ok {
		envelopeError("forbidden Host action")
	}
	optional := []string{}
	switch kind {
	case "call":
		optional = []string{"limits"}
	case "decide":
		optional = []string{"to", "broadcast"}
	case "answer":
		optional = []string{"fuel"}
	}
	envelopeFields(e, fields, optional...)
	for _, name := range []string{"script", "run", "grant", "delivery", "call", "reason"} {
		if raw, ok := e[name]; ok {
			envelopeText(raw)
		}
	}
	if raw, ok := e["object"]; ok {
		envelopeRef(raw)
	}
	if raw, ok := e["parent"]; ok && string(raw) != "null" {
		envelopeRef(raw)
	}
	if raw, ok := e["to"]; ok {
		to := envelopeObject(raw)
		if len(to) != 1 {
			envelopeError("invalid target")
		}
		if script, ok := to["script"]; ok {
			envelopeText(script)
		} else {
			envelopeFields(to, []string{"object"})
			envelopeRef(to["object"])
		}
	}
	if kind == "decide" {
		_, to := e["to"]
		b, broadcast := e["broadcast"]
		if to == broadcast || broadcast && !envelopeBool(b) {
			envelopeError("invalid decision target")
		}
	}
	if raw, ok := e["args"]; ok {
		envelopeArray(raw)
	}
	if raw, ok := e["limits"]; ok {
		validateLimits(raw)
	}
	if raw, ok := e["fuel"]; ok {
		envelopeNonnegative(raw)
	}
	if raw, ok := e["message"]; ok {
		m := envelopeObject(raw)
		envelopeFields(m, []string{"name"}, "args", "limits")
		envelopeText(m["name"])
		if args, ok := m["args"]; ok {
			envelopeArray(args)
		}
		if limits, ok := m["limits"]; ok {
			validateLimits(limits)
		}
	}
	if raw, ok := e["error"]; ok {
		validateFailure(raw)
	}
	if raw, ok := e["settlement"]; ok {
		s := envelopeObject(raw)
		if len(s) != 1 {
			envelopeError("invalid settlement")
		}
		for k, raw := range s {
			switch k {
			case "answer":
			case "fail":
				validateFailure(raw)
			case "reissue", "adopt":
				if !envelopeBool(raw) {
					envelopeError("invalid settlement flag")
				}
			default:
				envelopeError("invalid settlement")
			}
		}
	}
}
func envelopeArray(raw []byte) []json.RawMessage {
	var xs []json.RawMessage
	if json.Unmarshal(raw, &xs) != nil || xs == nil {
		envelopeError("invalid array")
	}
	return xs
}
func envelopeNonnegative(raw []byte) int64 {
	var n int64
	if json.Unmarshal(raw, &n) != nil || n < 0 || n >= 9007199254740992 {
		envelopeError("invalid nonnegative integer")
	}
	return n
}
func validateLimits(raw []byte) {
	e := envelopeObject(raw)
	envelopeFields(e, nil, "fuelPerRun", "allocPerRun", "maxWaitMs", "maxJoin")
	for _, n := range e {
		envelopeNonnegative(n)
	}
}
func validateFailure(raw []byte) {
	e := envelopeObject(raw)
	envelopeFields(e, []string{"code", "message", "data"})
	envelopeText(e["code"])
	envelopeText(e["message"])
}

// Action performs and records a normalized worker input. Values are supplied as
// Objects.Encode output, preserving insertion order and exact Function identity.
func (o *Objects) Action(request Envelope) Envelope {
	reply := o.perform(request)
	if !o.playback {
		o.emit(Envelope{"type": rawJSON("input"), "request": json.RawMessage(writeEnvelope(request)), "reply": json.RawMessage(writeEnvelope(reply))})
	}
	return reply
}

// Request builds framing fields; Values are automatically encoded as session references.
func (o *Objects) Request(fields map[string]any) Envelope {
	e := Envelope{}
	for k, x := range fields {
		e[k] = o.requestValue(x)
	}
	return o.Action(e)
}
func (o *Objects) requestValue(x any) json.RawMessage {
	switch x := x.(type) {
	case talk.Value:
		return o.Encode(x)
	case map[string]any:
		e := Envelope{}
		for k, val := range x {
			e[k] = o.requestValue(val)
		}
		return json.RawMessage(writeEnvelope(e))
	case []talk.Value:
		xs := []json.RawMessage{}
		for _, val := range x {
			xs = append(xs, o.Encode(val))
		}
		return rawJSON(xs)
	case []any:
		xs := []json.RawMessage{}
		for _, val := range x {
			xs = append(xs, o.requestValue(val))
		}
		return rawJSON(xs)
	default:
		return rawJSON(x)
	}
}
func (o *Objects) replayInput() { o.replayInputTracked(false) }
func (o *Objects) replayInputTracked(track bool) {
	e := o.consume("input")
	reply := o.perform(envelopeObject(e["request"]))
	if o.active || track {
		request := envelopeObject(e["request"])
		id := ""
		if raw, ok := reply["ok"]; ok {
			success := envelopeObject(raw)
			if raw, ok := success["delivery"]; ok {
				id = envelopeText(raw)
			} else if raw, ok := success["broadcast"]; ok {
				id = envelopeText(raw)
			}
		}
		o.queuedTraceActions = append(o.queuedTraceActions, traceAction{envelopeText(request["kind"]), id})
	}
	if string(rawJSON(reply)) != string(rawJSON(envelopeObject(e["reply"]))) {
		envelopeError("Host action reply mismatch")
	}
}
func (o *Objects) limits(raw []byte) *talk.LimitOverride {
	if raw == nil {
		return nil
	}
	e := envelopeObject(raw)
	envelopeFields(e, nil, "fuelPerRun", "allocPerRun", "maxWaitMs", "maxJoin")
	l := &talk.LimitOverride{}
	for k, b := range e {
		var n int64
		if json.Unmarshal(b, &n) != nil || n < 0 || n >= 9007199254740992 {
			envelopeError("invalid limits")
		}
		switch k {
		case "fuelPerRun":
			l.FuelPerRun = n
			l.Set |= talk.OverrideFuelPerRun
		case "allocPerRun":
			l.AllocPerRun = n
			l.Set |= talk.OverrideAllocPerRun
		case "maxWaitMs":
			l.MaxWait = time.Duration(n) * time.Millisecond
			l.Set |= talk.OverrideMaxWait
		case "maxJoin":
			l.MaxJoin = int(n)
			l.Set |= talk.OverrideMaxJoin
		}
	}
	return l
}
func (o *Objects) message(raw []byte) talk.Message {
	e := envelopeObject(raw)
	envelopeFields(e, []string{"name"}, "args", "limits")
	m := talk.Message{Name: envelopeText(e["name"]), Limits: o.limits(e["limits"])}
	if b, ok := e["args"]; ok {
		var args []json.RawMessage
		if json.Unmarshal(b, &args) != nil || args == nil {
			envelopeError("invalid args")
		}
		for _, a := range args {
			m.Args = append(m.Args, o.decode(a))
		}
	}
	return m
}
func (o *Objects) script(raw []byte) *talk.Script {
	s := o.group.Script(envelopeText(raw))
	if s == nil {
		envelopeError("unknown script")
	}
	return s
}
func (o *Objects) failure(raw []byte) *talk.ScriptError {
	f := envelopeObject(raw)
	envelopeFields(f, []string{"code", "message", "data"})
	return &talk.ScriptError{Code: envelopeText(f["code"]), Message: envelopeText(f["message"]), Data: o.decode(f["data"])}
}
func (o *Objects) perform(e Envelope) (reply Envelope) {
	validateRequest(e)
	kind := envelopeText(e["kind"])
	var err error
	payload := Envelope{}
	defer func() {
		if p := recover(); p != nil {
			if host, ok := p.(*talk.HostError); ok {
				reply = Envelope{"error": rawJSON(string(host.Code))}
			} else {
				panic(p)
			}
		}
	}()
	switch kind {
	case "set-parent":
		var parent *talk.Object
		if string(e["parent"]) != "null" {
			parent = o.ref(e["parent"])
		}
		err = o.group.SetParent(o.ref(e["object"]), parent)
	case "dispose":
		err = o.group.Dispose(o.ref(e["object"]))
	case "deliver", "request", "decide":
		m := o.message(e["message"])
		if kind == "decide" && string(e["broadcast"]) == "true" {
			id, _, x := o.group.DecideBroadcast(context.Background(), m)
			err = x
			payload["broadcast"] = rawJSON(string(id))
			break
		}
		to := envelopeObject(e["to"])
		if len(to) != 1 {
			envelopeError("invalid target")
		}
		var id talk.DeliveryID
		if s, ok := to["script"]; ok {
			script := o.script(s)
			switch kind {
			case "deliver":
				id, err = script.Deliver(m)
			case "request":
				id, _, err = script.Request(context.Background(), m)
			case "decide":
				id, _, err = script.Decide(context.Background(), m)
			}
		} else {
			obj := o.ref(to["object"])
			switch kind {
			case "deliver":
				id, err = o.group.Deliver(obj, m)
			case "request":
				id, _, err = o.group.Request(context.Background(), obj, m)
			case "decide":
				id, _, err = o.group.Decide(context.Background(), obj, m)
			}
		}
		payload["delivery"] = rawJSON(string(id))
	case "broadcast":
		id, x := o.group.Broadcast(o.message(e["message"]))
		err = x
		payload["broadcast"] = rawJSON(string(id))
	case "call":
		var args []json.RawMessage
		if json.Unmarshal(e["args"], &args) != nil || args == nil {
			envelopeError("invalid call args")
		}
		vs := []talk.Value{}
		for _, a := range args {
			vs = append(vs, o.decode(a))
		}
		id, _, x := o.group.Call(context.Background(), o.decode(e["fn"]), vs, o.limits(e["limits"]))
		err = x
		payload["delivery"] = rawJSON(string(id))
	case "cancel-delivery":
		sessionio.CancelDelivery(o.group, envelopeText(e["delivery"]))
	case "stop":
		o.script(e["script"]).Stop(envelopeText(e["reason"]))
	case "cancel-run":
		o.script(e["script"]).CancelRun(talk.RunID(envelopeText(e["run"])))
	case "revoke":
		o.script(e["script"]).Revoke(envelopeText(e["grant"]))
	case "answer":
		var fuel int64
		if raw, ok := e["fuel"]; ok {
			if json.Unmarshal(raw, &fuel) != nil {
				envelopeError("invalid Fuel")
			}
		}
		sessionio.Reply(o.group, envelopeText(e["call"]), o.decode(e["value"]), nil, fuel)
	case "fail":
		sessionio.Reply(o.group, envelopeText(e["call"]), talk.Nothing, o.failure(e["error"]), 0)
	case "settle":
		s := envelopeObject(e["settlement"])
		if len(s) != 1 {
			envelopeError("invalid settlement")
		}
		settlement := talk.Settlement{}
		switch {
		case s["answer"] != nil:
			x := o.decode(s["answer"])
			settlement.Answer = &x
		case s["fail"] != nil:
			settlement.Fail = o.failure(s["fail"])
		case string(s["reissue"]) == "true":
			settlement.Reissue = true
		case string(s["adopt"]) == "true":
			settlement.Adopt = true
		default:
			envelopeError("invalid settlement")
		}
		_, err = o.group.Settle(talk.CallID(envelopeText(e["call"])), settlement)
	}
	if err != nil {
		var host *talk.HostError
		if errors.As(err, &host) {
			return Envelope{"error": rawJSON(string(host.Code))}
		}
		envelopeError(fmt.Sprint(err))
	}
	return Envelope{"ok": json.RawMessage(writeEnvelope(payload))}
}
