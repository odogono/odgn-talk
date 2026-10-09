package session

import (
	"strings"

	talk "github.com/odogono/odgn-talk/impl/go"
	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
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
	tree, err := syntax.Parse(source)
	if err != nil {
		return h.refused(err, placement{}, 0)
	}
	declarations := fixDeclarations(source, tree)
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
func fixDeclarations(source string, tree *syntax.Tree) []declaration {
	lines := strings.Split(source, "\n")
	var out []declaration
	from := 0
	for i, n := range tree.Declarations {
		limit := len(source)
		if i+1 < len(tree.Declarations) {
			limit = tree.Declarations[i+1].Token.Start
		}
		end := n.Token.End
		for _, t := range tree.Tokens {
			if t.Start >= n.Token.Start && t.Start < limit && t.Kind != syntax.LineBreak && t.Kind != syntax.EOF {
				end = max(end, t.End)
			}
		}
		last := strings.Count(source[:end], "\n")
		first := from
		for first < last && strings.Trim(lines[first], " \t\r") == "" {
			first++
		}
		from = last + 1
		out = append(out, describe(strings.Join(lines[first:last+1], "\n"), n))
	}
	return out
}
