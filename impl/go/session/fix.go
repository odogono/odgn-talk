package session

import (
	"strings"

	talk "northtalk.org/go"
	"northtalk.org/go/internal/analysis"
)

// fix is `:fix <run> <path>`, or as a Transcript records it, the
// declarations on the lines after `:fix <run>`: Fix and Continue (ADR 0072).
func (h *Host) fix(rest string) []string {
	head, body, recorded := strings.Cut(rest, "\n")
	words := strings.Fields(head)
	if len(words) == 0 || recorded && len(words) != 1 || !recorded && len(words) != 2 {
		return refusal("bad arguments")
	}
	run := words[0]
	source := body + "\n"
	if !recorded {
		if h.env.ReadFile == nil {
			return refusal("bad arguments")
		}
		s, err := h.env.ReadFile(words[1])
		if err != nil {
			return refusal("bad arguments")
		}
		source = strings.TrimSuffix(s, "\n") + "\n"
		input := ":fix " + run + "\n" + strings.TrimSuffix(source, "\n")
		h.recording = &input
	}
	ds, err := analysis.Source(source)
	if err != nil {
		return h.refused(err, placement{}, 0)
	}
	declarations := fixDeclarations(source, ds)
	if len(declarations) == 0 {
		return refusal("bad arguments")
	}
	if _, ok := h.segments[run]; !ok {
		return refusal("no such run")
	}
	h.script.RewindRun(talk.RunID(run))
	out := h.pump()
	if !h.rewound {
		return append(out, "! not rewindable")
	}
	delete(h.segments, run)
	out = append(out, "! rewound "+run)
	next := h.declarations
	for _, d := range declarations {
		next = placed(next, d)
	}
	reloaded, err := h.reloadFrom(next, true)
	if err != nil {
		// The message runs again on the code it had.
		reloaded = h.refused(err, placement{}, -1)
	}
	out = append(out, reloaded...)
	return append(out, h.pump()...)
}

// fixDeclarations are `:fix`'s declarations. Each one's lines run from the
// line after the last one's last line, without the blank lines at their
// start, to its own last line, so the comments before it go with it.
func fixDeclarations(source string, ds []analysis.Declaration) []declaration {
	lines := strings.Split(source, "\n")
	var out []declaration
	from := 0
	for _, n := range ds {
		last := strings.Count(source[:n.Span.End], "\n")
		first := from
		for first < last && strings.Trim(lines[first], " \t\r") == "" {
			first++
		}
		from = last + 1
		out = append(out, describe(strings.Join(lines[first:last+1], "\n"), n))
	}
	return out
}
