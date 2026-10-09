package session

import (
	"reflect"
	"testing"
)

func TestFixReadsItsDeclarationsFromAFileAndRecordsThem(t *testing.T) {
	var items []Item
	h := New(Environment{
		ReadFile: func(path string) (string, error) {
			return "on tick, queued\n  say \"fixed\"\nend tick\n", nil
		},
		Record: func(i Item) { items = append(items, i) },
	})
	for _, source := range []string{
		":mock api.later suspending",
		":clock virtual 2026-09-30T10:00:00Z",
		"on tick, queued\n  ask api to later and wait\nend tick",
		"send tick to session",
		"send tick to session",
	} {
		h.Input(source)
	}
	got := h.Input(":fix session/r4 fix.talk")
	want := []string{"! rewound session/r4", "! discarded session/r2", "[session/r5] fixed"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
	recorded := ":fix session/r4\non tick, queued\n  say \"fixed\"\nend tick"
	for _, i := range items {
		if i.Kind == "input" && i.Text == recorded {
			return
		}
	}
	t.Fatalf("no input %q in %v", recorded, items)
}
