package session

import "encoding/json"

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
