package session

import "northtalk.org/go/internal/analysis"

func (h *Host) analyze(source string) (*analysis.Entry, error) {
	n := h.names()
	return analysis.ParseEntry(source, n.handlers, n.bound)
}
