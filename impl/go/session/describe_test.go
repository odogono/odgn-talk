package session

import (
	"reflect"
	"slices"
	"strings"
	"testing"
)

// The Transcripts in corpus/sessions/describe and corpus/sessions/apropos hold
// the rows; these check what a Transcript's output can't show.
func TestNameLookupReadsTheGroupOnlyForAScriptVariable(t *testing.T) {
	var trace []string
	h := New(Environment{Trace: func(line string) { trace = append(trace, line) }})
	for _, entry := range []string{":clock virtual 2026-09-30T10:00:00Z", "put 1 into n", "function f\nend f"} {
		h.Input(entry)
	}
	snapshots := func() int { return strings.Count(strings.Join(trace, "\n"), "> vars") }
	for _, command := range []string{":describe f", ":describe min", ":describe {library: \"text\", name: \"join\", origin: \"library\"}", ":apropos", ":apropos n"} {
		h.Input(command)
	}
	if n := snapshots(); n != 0 {
		t.Fatalf("%d snapshots for metadata lookups", n)
	}
	h.Input(":describe n")
	if n := snapshots(); n != 1 {
		t.Fatalf("%d snapshots for one Script Variable", n)
	}
}

func TestEmptyAproposQueryListsEveryName(t *testing.T) {
	h := New(Environment{})
	h.Input("put 1 into max")
	all := h.Input(":apropos")
	if len(all) == 0 || !reflect.DeepEqual(h.Input(`:apropos ""`), all) {
		t.Fatal(all)
	}
	// A shadowed Built-in is listed after the binding that shadows it.
	at := slices.Index(all, `name {target: {name: "max", origin: "session"}, origin: "session", available: true, import: nothing}`)
	if at < 0 || all[at+2] != `name {target: {name: "max", origin: "builtin"}, origin: "builtin", available: false, import: nothing}` {
		t.Fatal(all)
	}
}
