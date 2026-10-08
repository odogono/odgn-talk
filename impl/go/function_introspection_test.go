package northtalk

import (
	"strings"
	"testing"
)

func TestFunctionValueMetadataSurvivesCodeChangesAndRepeatedSaves(t *testing.T) {
	const original = "function double n, m = 1\n  return n * 2\nend double"
	const replacement = "function double n\n  return n + n\nend double"
	const variables = `script variable f
script variable pair
script variable zero
on setup
  put double into f
  put given [x, y], z: x + y + z into pair
  put given: 1 into zero
end setup
on inspect
  return [functionName(f), functionArity(f), functionName(pair), functionArity(pair), functionName(zero), functionArity(zero)]
end inspect
on callOld
  try
    f(2)
  catch e
    return the code of e
  end try
end callOld`
	for _, mode := range []string{"reload", "replace library", "variables only", "variables only changed library"} {
		t.Run(mode, func(t *testing.T) {
			c := New()
			library := func(source string) *Library {
				t.Helper()
				lib, err := c.CompileLibrary(LibrarySource{Name: "maths", Version: "1", Source: source}, nil, nil)
				if err != nil {
					t.Fatal(err)
				}
				return lib
			}
			g := c.NewGroup(GroupOptions{Name: "g"})
			var libraries []*Library
			source := original
			if strings.Contains(mode, "library") {
				libraries = []*Library{library(original)}
				g.AddLibrary(libraries[0])
				source = "use double from maths"
			}
			s := joinLoad(t, g, "s", source+"\n"+variables, Limits{})
			s.Deliver(Message{Name: "setup"})
			joinPump(t, g, 0, PumpOptions{})
			if mode == "reload" {
				if _, err := s.Reload(replacement+"\n"+variables, CarryVariables); err != nil {
					t.Fatal(err)
				}
			} else if mode == "replace library" {
				libraries = []*Library{library(replacement)}
				if _, err := g.ReplaceLibrary(libraries[0], CarryVariables); err != nil {
					t.Fatal(err)
				}
			} else if strings.Contains(mode, "library") {
				libraries = []*Library{library(replacement)}
			}
			policy := RejectMismatch
			if strings.HasPrefix(mode, "variables only") {
				policy = VariablesOnly
			}
			for round := 0; round < 2; round++ {
				saved, err := g.Save()
				if err != nil {
					t.Fatal(err)
				}
				if round == 0 && mode == "variables only" {
					saved = rewriteSave(t, saved, func(data map[string]any) { data["Versions"].(map[string]any)["CostModel"] = "old" })
				}
				copy, result, err := c.Restore(saved, RestoreOptions{Libraries: libraries, Mismatch: policy})
				if err != nil || result.VariablesOnly != (round == 0 && policy == VariablesOnly) {
					t.Fatal(result, err)
				}
				g = copy
				g.Script("s").Deliver(Message{Name: "inspect"})
				end := joinEnd(t, joinPump(t, g, 0, PumpOptions{}), "s")
				if end.Outcome != Completed || end.Result.String() != `["double", 1..2, nothing, 2..2, nothing, 0..0]` {
					t.Fatal(end)
				}
				g.Script("s").Deliver(Message{Name: "callOld"})
				end = joinEnd(t, joinPump(t, g, 0, PumpOptions{}), "s")
				if end.Outcome != Completed || end.Result.String() != `"function gone"` {
					t.Fatal(end)
				}
			}
		})
	}
}
