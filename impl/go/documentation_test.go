package northtalk

import (
	"testing"

	"github.com/odogono/odgn-talk/impl/go/internal/docs"
)

func functionDocOf(t *testing.T, g *Group, name string) string {
	t.Helper()
	for _, v := range g.Inspect().Scripts[0].Vars {
		if v.Key == name {
			doc, ok := docs.Function(v.Val)
			if !ok {
				t.Fatal(name, "is not a Function Value")
			}
			return doc
		}
	}
	t.Fatal("no Script Variable", name)
	return ""
}

func TestStaleFunctionValuesKeepTheirDocumentationThroughRestore(t *testing.T) {
	g := New().NewGroup(GroupOptions{Name: "g"})
	s := joinLoad(t, g, "s", "--| Doubles.\nfunction double n\n  return n * 2\nend double\nscript variable f\nscript variable l\non setup\n  put double into f\n  put given x: x into l\nend setup", Limits{})
	s.Deliver(Message{Name: "setup"})
	joinPump(t, g, 0, PumpOptions{})
	if doc := functionDocOf(t, g, "f"); doc != "Doubles." {
		t.Fatalf("live: %q", doc)
	}
	if doc := functionDocOf(t, g, "l"); doc != "" {
		t.Fatalf("lambda: %q", doc)
	}
	if _, err := s.Reload("function double n\n  return n + n\nend double\nscript variable f\nscript variable l", CarryVariables); err != nil {
		t.Fatal(err)
	}
	if doc := functionDocOf(t, g, "f"); doc != "Doubles." {
		t.Fatalf("stale: %q", doc)
	}
	saved, err := g.Save()
	if err != nil {
		t.Fatal(err)
	}
	copy, _, err := New().Restore(saved, RestoreOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if doc := functionDocOf(t, copy, "f"); doc != "Doubles." {
		t.Fatalf("restored stale: %q", doc)
	}
}

func TestVariablesOnlyRestoreKeepsTheDocumentationOfTheSavedCode(t *testing.T) {
	g := New().NewGroup(GroupOptions{Name: "g"})
	s := joinLoad(t, g, "s", "--| Doubles.\nfunction double n\n  return n * 2\nend double\nscript variable f\non setup\n  put double into f\nend setup", Limits{})
	s.Deliver(Message{Name: "setup"})
	joinPump(t, g, 0, PumpOptions{})
	saved, err := g.Save()
	if err != nil {
		t.Fatal(err)
	}
	saved = rewriteSave(t, saved, func(data map[string]any) { data["Versions"].(map[string]any)["CostModel"] = "old" })
	copy, result, err := New().Restore(saved, RestoreOptions{Mismatch: VariablesOnly})
	if err != nil || !result.VariablesOnly {
		t.Fatal(result, err)
	}
	if doc := functionDocOf(t, copy, "f"); doc != "Doubles." {
		t.Fatalf("variables only: %q", doc)
	}
}
