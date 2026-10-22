package session

import "github.com/odogono/odgn-talk/impl/go/internal/analysis"

func (h *Host) analyze(source string) (*analysis.Entry, error) {
	n := h.names()
	return analysis.ParseEntry(source, n.handlers, n.bound)
}
