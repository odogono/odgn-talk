package session

import (
	"slices"
	"strings"

	"github.com/odogono/odgn-talk/impl/go/internal/analysis"
)

func (h *Host) analyze(source string) (*analysis.Entry, error) {
	var handlers, bound []string
	for _, d := range h.declarations {
		for _, name := range d.names {
			// Selectors and the Fallback Handler are not variable Names.
			if !strings.ContainsAny(name, ": ") {
				bound = append(bound, name)
			}
		}
		if d.kind == "handler" {
			handlers = append(handlers, strings.Split(d.names[0], ":")[0])
		}
		if d.kind == "use" {
			for _, u := range d.uses {
				if libraryHandler(h.libraries[d.library].compiled, u.name) {
					handlers = append(handlers, u.local)
				}
			}
		}
	}
	for name := range h.implicit {
		handlers = append(handlers, name)
		bound = append(bound, name)
	}
	for name := range h.objectBindings {
		bound = append(bound, name)
	}
	// Stable context makes requests reproducible without changing source order.
	slices.Sort(handlers)
	slices.Sort(bound)
	return analysis.ParseEntry(source, handlers, slices.Compact(bound))
}
