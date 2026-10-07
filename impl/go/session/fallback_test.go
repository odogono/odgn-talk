package session

import (
	"reflect"
	"testing"
)

// A Session Script may be extended with a Fallback Handler, and entering
// another one redefines it, as for a Handler named `any message` (ADR 0063).
func TestFallbackHandlerEntries(t *testing.T) {
	h := New(Environment{})
	for _, entry := range []struct {
		source string
		output []string
	}{
		{":clock virtual 2026-09-30T10:00:00Z", nil},
		{"on go\nsend frob with 1, 2 to me and wait\nsay it\nend go", nil},
		{"on any message m\nreturn \"no \" & the name of m\nend any message", nil},
		{"go and wait", []string{`no frob`}},
		{"on any message {args: a}\nreturn a\nend", nil},
		{"go and wait", []string{`[1, 2]`}},
	} {
		if out := h.Input(entry.source); !reflect.DeepEqual(out, entry.output) {
			t.Fatalf("%s: got %v, want %v", entry.source, out, entry.output)
		}
	}
}
