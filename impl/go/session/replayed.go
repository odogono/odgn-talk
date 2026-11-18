package session

import (
	"encoding/json"
	"strings"
)

// replayed answers a session's needs from a recorded Transcript, as a
// replay does: each crossing with what the Host declared and did before its
// recorded `property-end`, and each live Restore with its recorded
// `resolve`. The session's place in the Transcript is the lines it has
// written so far.
type replayed struct {
	items []Item
	// Each item's first line, counting an input's `|` lines; a comment is
	// no line the session writes.
	starts  []int
	written int
}

func newReplayed(items []Item) *replayed {
	r := &replayed{items: items}
	at := 0
	for _, i := range items {
		r.starts = append(r.starts, at)
		switch i.Kind {
		case "comment":
		case "input":
			at += 1 + strings.Count(i.Text, "\n")
		default:
			at++
		}
	}
	return r
}

// next is the first item the session hasn't written.
func (r *replayed) next() int {
	k := 0
	for k < len(r.items) && (r.starts[k] < r.written || r.items[k].Kind == "comment") {
		k++
	}
	return k
}

func (r *replayed) envelope(k int) Envelope {
	if k >= len(r.items) || r.items[k].Kind != "envelope" {
		envelopeError("expected an envelope")
	}
	e, err := ParseEnvelope(r.items[k].Text)
	if err != nil {
		panic(err)
	}
	return e
}

// crossing is the `prop-result` for the crossing the session just began,
// whose `property-begin` must be the one recorded.
func (r *replayed) crossing(begin string) map[string]any {
	envelopes := []any{}
	k := r.next()
	if k == 0 || r.items[k-1].Kind != "envelope" || r.items[k-1].Text != begin {
		envelopeError("unmatched property crossing")
	}
	for ; ; k++ {
		e := r.envelope(k)
		switch envelopeText(e["type"]) {
		case "property-end":
			answer := map[string]any{}
			for key, x := range envelopeObject(e["reply"]) {
				answer[key] = json.RawMessage(x)
			}
			if len(envelopes) > 0 {
				answer["envelopes"] = envelopes
			}
			return answer
		case "input":
			envelopes = append(envelopes, requestOnly(e))
		default:
			envelopes = append(envelopes, r.items[k].Text)
		}
	}
}

// resolved is the recorded outcome for one identity of a live Restore.
func (r *replayed) resolved(kind, id string) bool {
	for k := r.next(); k < len(r.items); k++ {
		if r.items[k].Kind != "envelope" {
			continue
		}
		e := r.envelope(k)
		if envelopeText(e["type"]) != "resolve" {
			continue
		}
		var outcomes []Envelope
		json.Unmarshal(e["objects"], &outcomes)
		for _, o := range outcomes {
			if envelopeRef(o["object"]) == (objectReference{kind, id}) {
				return envelopeBool(o["resolved"])
			}
		}
		return false
	}
	return false
}

// declares reports whether the Transcript declares Host Objects, which a
// session serves live.
func (r *replayed) declares() bool {
	for _, i := range r.items {
		if i.Kind != "envelope" {
			continue
		}
		if e, err := ParseEnvelope(i.Text); err == nil && declaration(e) {
			return true
		}
	}
	return false
}
