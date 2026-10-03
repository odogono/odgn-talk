package check

import (
	"testing"

	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
)

func TestDecisionLoadRules(t *testing.T) {
	for _, tc := range []struct{ name, source, code string }{
		{"ordinary", "on go\n veto\nend go", "veto outside a decision"},
		{"function", "function f\n veto\nend f", "veto outside a decision"},
		{"called", "on go, deciding\n veto\nend go\non caller\n go\nend caller", "veto outside a decision"},
		{"function-style", "on go, deciding\n veto\nend go\non caller\n return go()\nend caller", "veto outside a decision"},
		{"lambda-call", "on go, deciding\n veto\nend go\non other\n put given: go() into f\nend other", "veto outside a decision"},
		{"late", "on go, deciding\n wait 1 s\n veto\nend go", "after a suspension"},
		{"branch", "on go n, deciding\n if n then wait 1 s\n veto\nend go", "after a suspension"},
		{"loop", "on go, deciding\n repeat 2 times\n  if true then veto\n  wait 1 s\n end repeat\nend go", "after a suspension"},
		{"catch", "on go, deciding\n try\n  wait 1 s\n  throw 1\n catch e\n  veto\n end try\nend go", "after a suspension"},
		{"local-wait", "on nap\n wait 1 s\nend nap\non go, deciding\n nap\n veto\nend go", "after a suspension"},
		{"overloaded-wait", "on nap where true\n wait 1 s\nend nap\non nap\n return\nend nap\non relay\n nap\nend relay\non go, deciding\n relay\n veto\nend go", "after a suspension"},
		{"pass", "on go, deciding\n wait 1 s\n pass go\nend go", "after a suspension"},
		{"early-return", "on go n, deciding\n if n then\n  wait 1 s\n  return\n end if\n veto\nend go", ""},
		{"loop-exit", "on go, deciding\n repeat forever\n  if true then veto\n  wait 1 s\n  exit repeat\n end repeat\nend go", ""},
		{"first-segment", "on go, deciding\n if false then veto\n wait 1 s\n return\nend go", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tree, err := syntax.Parse(tc.source)
			if err != nil {
				t.Fatal(err)
			}
			got := Check(tree, Options{}).Diagnostics
			if tc.code == "" {
				if len(got) != 0 {
					t.Fatal(got)
				}
				return
			}
			for _, d := range got {
				if d.Code == tc.code {
					return
				}
			}
			t.Fatalf("missing %s: %v", tc.code, got)
		})
	}
}

func TestDecisionCallUsesLambdaScope(t *testing.T) {
	tree, err := syntax.Parse("on go, deciding\n veto\nend go\non other\n put given go: go() into f\nend other")
	if err != nil {
		t.Fatal(err)
	}
	// The parameter clashes with a global name, but its call must not also
	// misclassify the deciding Handler as locally called.
	got := Check(tree, Options{}).Diagnostics
	if len(got) != 1 || got[0].Code != "name clash" {
		t.Fatal(got)
	}
}
