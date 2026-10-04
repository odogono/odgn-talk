package check

import (
	"testing"

	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
)

func TestEventFilterChecksInEnclosingScope(t *testing.T) {
	tree, err := syntax.Parse("on watch\n wait for go from (missing + 1)\nend watch")
	if err != nil {
		t.Fatal(err)
	}
	ds := Check(tree, Options{}).Diagnostics
	if len(ds) != 1 || ds[0].Code != "unknown name" {
		t.Fatal(ds)
	}
}

func TestEventWaitNotInLibrary(t *testing.T) {
	for _, source := range []string{"on watch\n wait for go\nend watch", "on watch\n wait for\n when go then return\n end wait\nend watch"} {
		tree, err := syntax.Parse(source)
		if err != nil {
			t.Fatal(err)
		}
		ds := Check(tree, Options{Library: true}).Diagnostics
		if len(ds) != 1 || ds[0].Code != "not in a library" {
			t.Fatal(ds)
		}
	}
}
