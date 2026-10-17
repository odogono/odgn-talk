package session

import (
	"context"
	"errors"
	"fmt"
	talk "github.com/odogono/odgn-talk/impl/go"
	"github.com/odogono/odgn-talk/impl/go/internal/analysis"
	"github.com/odogono/odgn-talk/impl/go/internal/docs"
	"regexp"
	"strings"
)

var readerIdentifier = regexp.MustCompile(`\bentry0\w*`)

func (h *Host) inspectExpression(source string) []string {
	entry, err := h.analyze(source)
	if err != nil {
		var parseError *analysis.Problem
		if errors.As(err, &parseError) && parseError.Trailing {
			return refusal("bad arguments")
		}
		return h.refused(err, placement{}, 0)
	}
	if entry.Kind != "expression" || !documentable(entry) {
		return refusal("bad arguments")
	}
	h.start()
	h.inspecting = true
	defer func() { h.inspecting = false }()
	_, out := h.run(source, true, entry)
	return out
}
func (h *Host) readProperties(x talk.Value) []string {
	reader := analysis.Catalogue().InspectReader
	ids := readerIdentifier.FindAllString(reader, -1)
	n := h.lastEntry + 1
	for {
		free := true
		for _, id := range ids {
			name := strings.Replace(id, "entry0", fmt.Sprintf("entry%d", n), 1)
			if h.has(name) || h.isHandler(name) {
				free = false
				break
			}
		}
		if free {
			break
		}
		n++
	}
	name := fmt.Sprintf("entry%d", n)
	source := readerIdentifier.ReplaceAllStringFunc(reader, func(id string) string { return strings.Replace(id, "entry0", name, 1) })
	if err := h.script.Extend(source); err != nil {
		return h.refused(err, placement{}, 0)
	}
	h.lastEntry = n
	h.implicit[name] = true
	h.units++
	_, names := docs.Inspection(x)
	args := []talk.Value{}
	for _, name := range names {
		v, err := talk.Text(name)
		must(err)
		args = append(args, v)
	}
	m := talk.Message{Name: name + ":to:", Args: []talk.Value{x, talk.List(args...)}}
	if len(h.limits) > 0 {
		o := h.override()
		m.Limits = &o
	}
	id, _, err := h.script.Request(context.Background(), m)
	if err != nil {
		return h.refused(err, placement{}, 0)
	}
	h.foreground = entryRun{delivery: string(id)}
	h.latest = h.foreground
	return h.pump()
}
