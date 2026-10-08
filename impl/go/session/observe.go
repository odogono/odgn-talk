package session

import (
	"fmt"
	"maps"
	"slices"
	"strconv"
	"strings"

	talk "github.com/odogono/odgn-talk/impl/go"
	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
	coretrace "github.com/odogono/odgn-talk/impl/go/internal/trace"
)

// measurement is one `:fuel` Entry's Fuel Measurement: its root Delivery and
// every Run and queued message spawned from it (session-observation.md).
type measurement struct {
	entry             int
	root              string
	runs              []string // member Runs in first-reported order
	fuel              map[string]int64
	live, queued      int64
	counted           bool // a causal work record has reported the root
	interrupted       bool
	announced, closed bool // printed its first row; printed its final row
}

func (m *measurement) settled() bool { return m.counted && m.live == 0 && m.queued == 0 }
func (m *measurement) clone() *measurement {
	c := *m
	c.runs = slices.Clone(m.runs)
	c.fuel = maps.Clone(m.fuel)
	return &c
}

// observation is the Session's trace filters, latched traced Runs and Fuel
// Measurements. It reads only public Run accounting reports.
type observation struct {
	filters      map[string]bool
	traced       map[string]string // Run -> its message Selector
	measurements []*measurement
	lines        []string // trace rows awaiting the end of this Host call
}

func newObservation() observation {
	return observation{filters: map[string]bool{}, traced: map[string]string{}}
}
func (o observation) clone() observation {
	c := observation{filters: maps.Clone(o.filters), traced: maps.Clone(o.traced)}
	for _, m := range o.measurements {
		c.measurements = append(c.measurements, m.clone())
	}
	return c
}

var outcomes = []string{"completed", "errored", "limit fault", "cancelled", "unhandled", "dropped", "effect failed"}

// row is a map in the display form, its fields in the order given.
func row(fields ...string) string {
	var b strings.Builder
	b.WriteByte('{')
	for i := 0; i < len(fields); i += 2 {
		if i > 0 {
			b.WriteString(", ")
		}
		b.WriteString(fields[i] + ": " + fields[i+1])
	}
	b.WriteByte('}')
	return b.String()
}
func textForm(s string) string {
	v, err := talk.Text(s)
	must(err)
	return v.String()
}

// observe follows one Host call's reports, in order. errors holds each
// errored Run's projected error, as its `! error` row shows it.
func (h *Host) observe(reports []talk.Report, errors map[string]string) {
	o := &h.observation
	end := func(script, run string, fields ...string) {
		selector, ok := o.traced[run]
		if !ok {
			return
		}
		delete(o.traced, run)
		o.lines = append(o.lines, "trace end "+row(append([]string{"script", textForm(script), "run", textForm(run), "selector", textForm(selector)}, fields...)...))
	}
	for _, r := range reports {
		switch r := r.(type) {
		case *talk.RunStarted:
			if r.Function == nil && o.filters[r.Selector] {
				o.traced[string(r.Run)] = r.Selector
				o.lines = append(o.lines, "trace start "+row("script", textForm(r.Script), "run", textForm(string(r.Run)), "selector", textForm(r.Selector), "args", coretrace.Host(talk.List(r.Args...))))
			}
		case *talk.RunEnd:
			fields := []string{"outcome", textForm(outcomes[r.Outcome])}
			switch r.Outcome {
			case talk.Completed:
				fields = append(fields, "result", coretrace.Host(r.Result))
			case talk.Errored:
				fields = append(fields, "error", errors[string(r.Run)])
			case talk.LimitFault:
				fields = append(fields, "limit", textForm(r.Limit))
			case talk.EffectFailureOutcome:
				if e := r.Effect; e != nil {
					effect := []string{"script", textForm(e.Script), "run", textForm(string(e.Run)), "grant", textForm(e.Grant), "segment", textForm(e.Segment), "phase", textForm(e.Phase), "status", textForm(string(e.Status))}
					if e.Scope != "" {
						effect = append(effect, "scope", textForm(e.Scope))
					}
					fields = append(fields, "effect", row(effect...))
				}
			}
			if r.Run != "" {
				end(r.Script, string(r.Run), fields...)
			}
		case *talk.RunDiscarded:
			end(r.Script, string(r.Run), "outcome", textForm("discarded"), "reason", textForm(r.Reason))
		case *talk.RunAccounting:
			if m := h.measured(string(r.RootDelivery)); m != nil {
				if _, ok := m.fuel[string(r.Run)]; !ok {
					m.runs = append(m.runs, string(r.Run))
				}
				m.fuel[string(r.Run)] = r.Fuel
				m.interrupted = m.interrupted || r.State == "discarded"
			}
		case *talk.CausalWork:
			if m := h.measured(string(r.RootDelivery)); m != nil {
				m.counted = true
				m.live, m.queued = r.LiveRuns, r.QueuedMessages
				m.interrupted = m.interrupted || r.DiscardedMessages > 0
			}
		}
	}
}
func (h *Host) measured(root string) *measurement {
	for _, m := range h.observation.measurements {
		if m.root == root {
			return m
		}
	}
	return nil
}

// observed gives this Host call's trace rows, then its Fuel milestones: a new
// measurement's first row, and the final row of each one that has settled.
func (h *Host) observed() []string {
	o := &h.observation
	out := o.lines
	o.lines = nil
	for _, m := range o.measurements {
		if m.closed || m.announced && !m.settled() {
			continue
		}
		m.announced = true
		m.closed = m.settled()
		out = append(out, "fuel "+m.row())
	}
	return out
}
func (m *measurement) row() string {
	var fuel int64
	for _, run := range m.runs {
		fuel += m.fuel[run]
	}
	state := "complete"
	if !m.settled() {
		state = "pending"
	} else if m.interrupted {
		state = "interrupted"
	}
	return row("entry", textForm(fmt.Sprintf("entry%d", m.entry)), "fuel", strconv.FormatInt(fuel, 10), "state", textForm(state), "interrupted", strconv.FormatBool(m.interrupted), "runs", strconv.FormatInt(m.live, 10), "queued", strconv.FormatInt(m.queued, 10))
}

// selectorText is a full Selector, as a static `send` could name a message.
func selectorText(s string) bool {
	arity := 0
	if strings.Contains(s, ":") {
		arity = strings.Count(s, ":")
	}
	return syntax.ValidComputedMessageName(s, arity)
}
func (h *Host) trace(name, rest string) []string {
	o := &h.observation
	selector := strings.TrimSpace(rest)
	if selector != "" && !selectorText(selector) {
		return refusal("bad arguments")
	}
	switch {
	case name == "untrace" && selector == "":
		clear(o.filters)
	case name == "untrace":
		delete(o.filters, selector)
	case selector != "":
		o.filters[selector] = true
	default:
		var out []string
		for _, s := range slices.Sorted(maps.Keys(o.filters)) {
			out = append(out, "trace "+textForm(s))
		}
		return out
	}
	return nil
}

// fuel lists every measurement, or measures one statement or expression.
func (h *Host) fuel(rest string) []string {
	if strings.TrimSpace(rest) == "" {
		var out []string
		for _, m := range h.observation.measurements {
			out = append(out, "fuel "+m.row())
		}
		return out
	}
	if strings.HasPrefix(rest, ":") {
		return refusal("bad arguments")
	}
	h.start()
	kind, node, err := syntax.ParseEntry(rest, h.isHandler)
	if err != nil {
		return h.refused(err, placement{}, 0)
	}
	if !documentable(rest, kind, node) || kind != "statement" && kind != "expression" {
		return refusal("bad arguments")
	}
	h.measuring = true
	defer func() { h.measuring = false }()
	_, out := h.run(rest, kind == "expression", node)
	return out
}
