package session

import (
	"fmt"
	"strings"
	"time"

	talk "github.com/odogono/odgn-talk/impl/go"
	"github.com/odogono/odgn-talk/impl/go/internal/docs"
	"github.com/odogono/odgn-talk/impl/go/internal/value"
)

func callRun(id string) string {
	i := strings.LastIndex(id, ".")
	if i < 0 {
		return ""
	}
	return id[:i]
}
func wordField(line, key string) string {
	_, rest, ok := strings.Cut(line, " "+key+"=")
	if !ok {
		return ""
	}
	head, _, _ := strings.Cut(rest, " ")
	return head
}
func displayField(line, key string) value.Value {
	_, rest, ok := strings.Cut(line, " "+key+"=")
	if !ok {
		return value.Value{}
	}
	r := value.Reader{Text: rest}
	v, err := r.Value()
	must(err)
	return v
}

// Record observes only canonical Trace records. It never calls the Group.
func (h *Host) Record(line string) {
	if h.env.Trace != nil {
		h.env.Trace(line)
	}
	parts := strings.Fields(line)
	if len(parts) == 0 {
		return
	}
	e := event{kind: parts[0], line: line}
	switch e.kind {
	case "seg":
		e.run = parts[1]
		e.delivery = wordField(line, "delivery")
		e.seg.end = wordField(line, "end")
		e.seg.calls = wordField(line, "calls") != ""
		if raw := wordField(line, "until"); raw != "" {
			e.seg.until = parseTime(raw)
		}
	case "call":
		e.run = callRun(parts[1])
	case "run":
		e.run = parts[1]
		e.delivery = wordField(line, "delivery")
		e.outcome = wordField(line, "outcome")
	case "unhandled":
		// unhandled follows the run record; its own schema need not carry a Run.
		for i := len(h.events) - 1; i >= 0; i-- {
			if h.events[i].kind == "run" && h.events[i].outcome == "unhandled" {
				e.run = h.events[i].run
				break
			}
		}
	default:
		return
	}
	h.events = append(h.events, e)
}
func parseTime(s string) time.Time {
	v, err := value.ParseDisplay(s, nil)
	must(err)
	if v.Kind != value.Instant {
		panic("Clock reading is not an Instant")
	}
	return time.Unix(v.Seconds, int64(v.Nanos)).UTC()
}
func formatTime(t time.Time) string { return talk.InstantFromTime(t).String() }
func (h *Host) pump() []string {
	h.recorded()
	reading := h.virtual
	if !h.virtualOn {
		reading = h.env.Now()
		h.record(Item{Kind: "clock", At: reading})
	}
	if h.hasClock && reading.Before(h.lastClock) {
		reading = h.lastClock
	}
	h.lastClock = reading
	h.hasClock = true
	h.events = nil
	result, err := h.group.Pump(reading, talk.PumpOptions{})
	if err != nil {
		return h.refused(err, placement{}, 0)
	}
	h.objectSession.reports(result.Reports)
	h.deadline = result.NextDeadline
	ends := map[string]*talk.RunEnd{}
	for _, r := range result.Reports {
		if end, ok := r.(*talk.RunEnd); ok {
			ends[string(end.Run)] = end
		}
	}
	for _, e := range h.events {
		if e.kind == "seg" && e.delivery != "" {
			if h.foreground.delivery == e.delivery {
				h.foreground.run = e.run
			}
			if h.latest.delivery == e.delivery {
				h.latest.run = e.run
			}
		}
	}
	var out []string
	errors := map[string]string{}
	for _, e := range h.events {
		switch e.kind {
		case "seg":
			h.segments[e.run] = e.seg
		case "call":
			id := strings.Fields(e.line)[1]
			if v, ok := h.writes[id]; ok {
				delete(h.writes, id)
				text := v.String()
				if s, ok := v.AsText(); ok {
					text = s
				}
				for _, s := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
					out = append(out, h.prefix(e.run)+s)
				}
			}
			op := wordField(e.line, "op")
			grant, operation, _ := strings.Cut(op, ".")
			capability := h.granted[grant]
			for _, m := range h.mocks {
				if m.capability == capability && m.operation == operation {
					out = append(out, h.prefix(e.run)+"call "+id+" "+capability+"."+operation+" "+displayField(e.line, "args").Display())
					break
				}
			}
		case "unhandled":
			args := displayField(e.line, "args")
			if args.Kind == value.Nothing {
				args = value.Value{Kind: value.List}
			}
			out = append(out, h.prefix(e.run)+"! unhandled "+wordField(e.line, "message")+" "+args.Display())
		case "run":
			delete(h.segments, e.run)
			end := ends[e.run]
			text := ""
			switch e.outcome {
			case "completed":
				if h.inspections[e.delivery] && end != nil {
					rows, _ := docs.Inspection(end.Result)
					for _, row := range rows {
						out = append(out, h.prefix(e.run)+row)
					}
					if end.Result.Kind() == talk.KindObject {
						x := end.Result
						h.reader = &x
					}
				} else if h.expressions[e.delivery] {
					text = "nothing"
					if end != nil {
						text = end.Result.String()
					}
				}
			case "errored":
				err := displayField(e.line, "error")
				kept := []value.Pair{}
				for _, p := range err.Entries {
					if p.Key != "message" && p.Key != "at" {
						kept = append(kept, p)
					}
				}
				err.Entries = kept
				errors[e.run] = err.Display()
				text = "! error " + err.Display() + " at " + h.location(end)
			case "limit-fault":
				text = "! limit fault " + end.Limit + " at " + h.location(end)
			case "cancelled":
				text = "! cancelled"
			case "effect-failed":
				text = "! effect failed"
			}
			if text != "" {
				out = append(out, h.prefix(e.run)+text)
			}
			delete(h.expressions, e.delivery)
			delete(h.inspections, e.delivery)
		}
	}
	h.observe(result.Reports, errors)
	h.pruneCalls()
	h.settleForeground()
	if h.reader != nil {
		x := *h.reader
		h.reader = nil
		out = append(out, h.readProperties(x)...)
	}
	return out
}
func (h *Host) prefix(run string) string {
	if run == "" || h.foreground.run == run {
		return ""
	}
	return "[" + run + "] "
}
func (h *Host) location(end *talk.RunEnd) string {
	if end == nil {
		return "?"
	}
	at := end.At
	if p, ok := h.placements[at.Unit]; ok {
		return where(at.Unit, at.Line, at.Col, p, 0)
	}
	return fmt.Sprintf("%s:%d:%d", at.Unit, at.Line, at.Col)
}
func (h *Host) settleForeground() {
	run := h.foreground.run
	s, ok := h.segments[run]
	if run != "" && ok {
		for id, c := range h.reads {
			if callRun(id) == run && c.Context().Err() == nil {
				h.waiting = Waiting{Kind: "read"}
				return
			}
		}
		if !h.virtualOn && !s.calls && !s.until.IsZero() && (s.end == "wait" || s.end == "wait-for" || s.end == "wait-for-any") {
			h.waiting = Waiting{Kind: "deadline", At: s.until}
			return
		}
	}
	h.foreground = entryRun{}
	h.waiting = Waiting{Kind: "prompt"}
}

// Abandoned Calls must not keep their frames alive in the Host.
func (h *Host) pruneCalls() {
	for id, c := range h.pending {
		if c.Context().Err() != nil {
			delete(h.pending, id)
		}
	}
	active := h.readOrder[:0]
	for _, id := range h.readOrder {
		c := h.reads[id]
		if c != nil && c.Context().Err() == nil {
			active = append(active, id)
		} else {
			delete(h.reads, id)
		}
	}
	h.readOrder = active
}
