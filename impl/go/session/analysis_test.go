package session

import (
	"fmt"
	"reflect"
	"testing"
)

// A Selector is bound in the session but cannot be declared as a Script
// Variable in the analysis request's implicit-name environment.
func TestImplicitEntryAfterSelectorDeclaration(t *testing.T) {
	h := New(Environment{})
	if out := h.Input("on move x to y\n return x + y\nend move"); len(out) != 0 {
		t.Fatal(out)
	}
	if out := h.Input("put 7 into total"); len(out) != 0 {
		t.Fatal(out)
	}
	if out := h.Input("total"); !reflect.DeepEqual(out, []string{"7"}) {
		t.Fatal(out)
	}
	if got := h.Source(); got != "on move x to y\n return x + y\nend move\nscript variable total\n" {
		t.Fatal(got)
	}
}

func TestPassiveAnalysisBeforeSessionStarts(t *testing.T) {
	h := New(Environment{})
	if !h.NeedsMore("--| Pending.\n") || h.NeedsMore("--| Detached.\n\n") || !h.NeedsMore(":inspect [1,\n") {
		t.Fatal("incorrect continuation state")
	}
	if out := h.Input(":trace move:to:"); len(out) != 0 {
		t.Fatal(out)
	}
	if out := h.Input(":trace move::"); !reflect.DeepEqual(out, []string{"! bad arguments"}) {
		t.Fatal(out)
	}
	// Description uses both the Core's catalogue and declaration metadata.
	if ds := builtinDeclared("abs"); len(ds) != 1 || ds[0].signature == "" || ds[0].doc == "" {
		t.Fatal(ds)
	}
	if ds := h.libraryDeclared("text", "join"); len(ds) != 1 || ds[0].arity == nil || ds[0].doc == "" {
		t.Fatal(ds)
	}
	if h.Started() || h.Source() != "" {
		t.Fatal("analysis started the Session Script")
	}
}

func TestConcurrentSessionAnalysis(t *testing.T) {
	for i := range 8 {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			t.Parallel()
			h := New(Environment{})
			name := fmt.Sprintf("count%d", i)
			h.declarations = []declaration{{kind: "variable", names: []string{name}, source: "script variable " + name}}
			for range 4 {
				entry, err := h.analyze("put 1 into " + name)
				if err != nil || entry.Kind != "statement" || len(entry.Implicit) != 0 {
					t.Fatalf("%+v, %v", entry, err)
				}
				entry, err = h.analyze("put 1 into fresh")
				if err != nil || !reflect.DeepEqual(entry.Implicit, []string{"fresh"}) {
					t.Fatalf("%+v, %v", entry, err)
				}
			}
		})
	}
}

func TestEntryRefusesMultipleDeclarations(t *testing.T) {
	h := New(Environment{})
	if h.NeedsMore("constant a = 1\nfunction b") {
		t.Fatal("trailing declaration requested continuation")
	}
	out := h.Input("constant a = 1\nconstant b = 2")
	if !reflect.DeepEqual(out, []string{"! unexpected token at 2:1"}) {
		t.Fatal(out)
	}
	if h.Source() != "" {
		t.Fatal("refused Entry changed Session Source")
	}
}

func TestAnalysisRetainsSourceScalars(t *testing.T) {
	h := New(Environment{})
	source := "--| e\u0301\nscript variable text = \"e\u0301\""
	entry, err := h.analyze(source)
	if err != nil {
		t.Fatal(err)
	}
	d := entry.Declarations[0]
	if d.Doc != "e\u0301" || d.Initializer == nil || *d.Initializer != "\"e\u0301\"" {
		t.Fatalf("%+v", d)
	}
	if source[d.Span.Start:d.Span.End] != "script variable text = \"e\u0301\"" {
		t.Fatal(d.Span)
	}
}
