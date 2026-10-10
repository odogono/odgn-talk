package messagelayer

import talk "github.com/odogono/odgn-talk/impl/go"

// Reports are talk.ts's Report union as data.

var outcomes = map[talk.Outcome]string{talk.Completed: "completed", talk.Errored: "errored", talk.LimitFault: "limit fault", talk.Cancelled: "cancelled", talk.UnhandledOutcome: "unhandled", talk.Dropped: "dropped", talk.EffectFailureOutcome: "effect failed"}

func reportForms(rs []talk.Report) ([]any, error) {
	out := []any{}
	for _, r := range rs {
		form, err := reportForm(r)
		if err != nil {
			return nil, err
		}
		out = append(out, form)
	}
	return out, nil
}

func reportForm(r talk.Report) (map[string]any, error) {
	switch r := r.(type) {
	case *talk.RunEnd:
		out := map[string]any{"kind": "run end", "script": r.Script, "outcome": outcomes[r.Outcome], "fuel": integer(r.Fuel), "alloc": integer(r.Alloc)}
		optional(out, "run", string(r.Run))
		optional(out, "delivery", string(r.Delivery))
		optional(out, "broadcast", string(r.Broadcast))
		optional(out, "handler", r.Handler)
		optional(out, "limit", r.Limit)
		if r.Fallback {
			out["fallback"] = true
		}
		if r.Effect != nil {
			out["effect"] = effectFailureForm(r.Effect)
		}
		if c := r.CleanupFailed; c != nil {
			if c.Code != "" {
				out["cleanupFailed"] = map[string]any{"code": c.Code}
			} else {
				out["cleanupFailed"] = map[string]any{"limit": c.Limit}
			}
		}
		if r.Outcome == talk.Completed {
			v, err := encodeValue(r.Result)
			if err != nil {
				return nil, err
			}
			out["result"] = v
		}
		if r.Error != nil {
			e, err := scriptErrorForm(r.Error)
			if err != nil {
				return nil, err
			}
			out["error"] = e
		}
		if r.At.Unit != "" {
			out["at"] = map[string]any{"unit": r.At.Unit, "line": r.At.Line, "col": r.At.Col, "handler": r.At.Handler, "pc": r.At.PC}
		}
		return out, nil
	case *talk.Stop:
		return map[string]any{"kind": "stop", "script": r.Script, "reason": r.Reason, "discardedRuns": ids(r.DiscardedRuns), "droppedMessages": ids(r.DroppedMessages), "pendingCalls": ids(r.PendingCalls)}, nil
	case *talk.Unhandled:
		args, err := encodeValues(r.Message.Args)
		if err != nil {
			return nil, err
		}
		out := map[string]any{"kind": "unhandled", "delivery": string(r.Delivery), "message": map[string]any{"name": r.Message.Name, "args": args}}
		if r.Target != nil {
			target, err := encodeValue(r.Target.Value())
			if err != nil {
				return nil, err
			}
			out["target"] = target
		}
		return out, nil
	case *talk.CallFailed:
		return map[string]any{"kind": "call failed", "script": r.Script, "call": string(r.Call), "operation": map[string]any{"capability": r.Operation.Capability, "operation": r.Operation.Operation}, "detail": r.Detail}, nil
	case *talk.EffectFailure:
		out := effectFailureForm(r)
		out["kind"] = "effect failure"
		return out, nil
	case *talk.HostError:
		out := map[string]any{"kind": "host error", "code": string(r.Code)}
		optional(out, "detail", r.Detail)
		return out, nil
	case *talk.RunStarted:
		args, err := encodeValues(r.Args)
		if err != nil {
			return nil, err
		}
		out := ancestry(map[string]any{"kind": "run started", "script": r.Script, "run": string(r.Run), "args": args}, r.RunAncestry)
		optional(out, "delivery", string(r.Delivery))
		optional(out, "selector", r.Selector)
		if r.Function != nil {
			fn, err := encodeValue(*r.Function)
			if err != nil {
				return nil, err
			}
			out["fn"] = fn
		}
		return out, nil
	case *talk.RunDiscarded:
		return ancestry(map[string]any{"kind": "run discarded", "script": r.Script, "run": string(r.Run), "reason": r.Reason}, r.RunAncestry), nil
	case *talk.RunAccounting:
		return ancestry(map[string]any{"kind": "run accounting", "script": r.Script, "run": string(r.Run), "fuel": integer(r.Fuel), "state": r.State}, r.RunAncestry), nil
	case *talk.CausalWork:
		return map[string]any{"kind": "causal work", "rootDelivery": string(r.RootDelivery), "liveRuns": integer(r.LiveRuns), "queuedMessages": integer(r.QueuedMessages), "discardedMessages": integer(r.DiscardedMessages)}, nil
	}
	return nil, protocolErrorf("report %T isn't carried by this Message Layer yet", r)
}

func effectFailureForm(e *talk.EffectFailure) map[string]any {
	out := map[string]any{"script": e.Script, "run": string(e.Run), "grant": e.Grant, "segment": e.Segment, "phase": e.Phase, "status": string(e.Status)}
	optional(out, "scope", e.Scope)
	optional(out, "detail", e.Detail)
	return out
}

func ancestry(out map[string]any, a talk.RunAncestry) map[string]any {
	out["rootDelivery"] = string(a.RootDelivery)
	optional(out, "parentRun", string(a.ParentRun))
	optional(out, "parentCall", string(a.ParentCall))
	return out
}

func scriptErrorForm(e *talk.ScriptError) (map[string]any, error) {
	out := map[string]any{"code": e.Code, "message": e.Message}
	if e.Data.Kind() != talk.KindNothing {
		data, err := encodeValue(e.Data)
		if err != nil {
			return nil, err
		}
		out["data"] = data
	}
	return out, nil
}

// scriptError reads a ScriptError: {code, message, data (V)}.
func (f fields) scriptError(key string, g *group) (*talk.ScriptError, error) {
	e, err := f.sub(key)
	if err != nil {
		return nil, err
	}
	code, err := e.str("code")
	if err != nil {
		return nil, err
	}
	message, err := e.optionalStr("message")
	if err != nil {
		return nil, err
	}
	data := talk.Nothing
	if e.has("data") {
		if data, err = e.value("data", g); err != nil {
			return nil, err
		}
	}
	return &talk.ScriptError{Code: code, Message: message, Data: data}, nil
}

func optional(out map[string]any, key, value string) {
	if value != "" {
		out[key] = value
	}
}

func ids[T ~string](xs []T) []string {
	out := make([]string, len(xs))
	for i, x := range xs {
		out[i] = string(x)
	}
	return out
}

// traceBuffer is a Group's TraceSink; each reply takes the records made since
// the last.
type traceBuffer struct{ lines []string }

func (t *traceBuffer) Record(line string) { t.lines = append(t.lines, line) }

func (t *traceBuffer) take() []string {
	out := t.lines
	t.lines = nil
	if out == nil {
		out = []string{}
	}
	return out
}
