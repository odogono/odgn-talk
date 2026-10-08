package session

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"

	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
)

// docsFixture is impl/testdata/declaration-docs.json, which the TS Core's
// documentation tests read too.
type docsFixture struct {
	Units []struct {
		Name, Source string
		Docs         [][2]string
	}
	Sessions []struct {
		Name  string
		Steps []struct {
			Input       *string
			Output      []string
			Incomplete  *string
			Docs        *string
			Library     []string
			FunctionDoc *string `json:"functionDoc"`
			Expect      json.RawMessage
		}
	}
}

func readDocsFixture(t *testing.T) docsFixture {
	t.Helper()
	b, err := os.ReadFile("../../testdata/declaration-docs.json")
	if err != nil {
		t.Fatal(err)
	}
	var f docsFixture
	if err := json.Unmarshal(b, &f); err != nil {
		t.Fatal(err)
	}
	return f
}

func TestDeclarationDocumentationAttachesToTopLevelDeclarations(t *testing.T) {
	for _, u := range readDocsFixture(t).Units {
		tree, err := syntax.Parse(u.Source)
		if err != nil {
			t.Fatal(u.Name, err)
		}
		got := [][2]string{}
		for _, n := range tree.Declarations {
			got = append(got, [2]string{n.Kind, tree.Documentation(n)})
		}
		if !reflect.DeepEqual(got, u.Docs) {
			t.Errorf("%s:\n got %q\nwant %q", u.Name, got, u.Docs)
		}
	}
}

func TestDeclarationDocumentationInTheSession(t *testing.T) {
	for _, s := range readDocsFixture(t).Sessions {
		h := New(Environment{})
		for i, step := range s.Steps {
			var got, want any
			switch {
			case step.Input != nil:
				got, want = h.Input(*step.Input), step.Output
				if len(step.Output) == 0 {
					want = []string(nil)
				}
			case step.Incomplete != nil:
				got = h.NeedsMore(*step.Incomplete)
				var b bool
				_ = json.Unmarshal(step.Expect, &b)
				want = b
			case step.Docs != nil || step.Library != nil:
				var docs []Doc
				if step.Docs != nil {
					docs = h.Documentation(*step.Docs)
				} else {
					docs = h.LibraryDocumentation(step.Library[0], step.Library[1])
				}
				rows := [][]any{}
				for _, d := range docs {
					rows = append(rows, []any{d.Origin, d.Declaration, float64(d.Clause), d.Text})
				}
				got = rows
				var w [][]any
				_ = json.Unmarshal(step.Expect, &w)
				if w == nil {
					w = [][]any{}
				}
				want = w
			case step.FunctionDoc != nil:
				got = nil
				for _, v := range h.Inspect().Scripts[0].Vars {
					if v.Key == *step.FunctionDoc {
						if doc, ok := h.FunctionDocumentation(v.Val); ok {
							got = doc
						}
					}
				}
				var w *string
				_ = json.Unmarshal(step.Expect, &w)
				want = nil
				if w != nil {
					want = *w
				}
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("%s, step %d:\n got %#v\nwant %#v", s.Name, i, got, want)
			}
		}
	}
}
