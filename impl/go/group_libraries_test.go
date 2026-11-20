package northtalk

import (
	"testing"
)

// Libraries gives the Group's Libraries in add order with a replacement's
// recompiled dependant, and a restore with them straight after a save is full
// (#2341).
func TestGroupLibrariesAfterTransitiveReplace(t *testing.T) {
	c := New()
	var trace lines
	g := c.NewGroup(GroupOptions{Trace: &trace})
	if got := g.Libraries(); len(got) != 0 {
		t.Fatal(got)
	}
	base, err := c.CompileLibrary(LibrarySource{Name: "base", Source: "function f\n return 1\nend f"}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	wrapper, err := c.CompileLibrary(LibrarySource{Name: "wrapper", Source: "use f from base\nfunction g\n return f()\nend g"}, []*Library{base}, nil)
	if err != nil {
		t.Fatal(err)
	}
	next, err := c.CompileLibrary(LibrarySource{Name: "base", Source: "function f\n return 2\nend f"}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, l := range []*Library{base, wrapper} {
		if err := g.AddLibrary(l); err != nil {
			t.Fatal(err)
		}
	}
	if got := g.Libraries(); len(got) != 2 || got[0] != base || got[1] != wrapper {
		t.Fatal(got)
	}
	if _, err := g.Load(LoadOptions{Name: "s", Source: "use g from wrapper\non go\n return g()\nend go"}); err != nil {
		t.Fatal(err)
	}
	if _, err := g.ReplaceLibrary(next, ResetVariables); err != nil {
		t.Fatal(err)
	}
	traced := len(trace)
	current := g.Libraries()
	if len(trace) != traced {
		t.Fatal("Libraries wrote to the Trace")
	}
	if len(current) != 2 || current[0] != next || current[1].Name() != "wrapper" || current[1].Identity() == wrapper.Identity() {
		t.Fatal(current)
	}
	saved, err := g.Save()
	if err != nil {
		t.Fatal(err)
	}
	restored, result, err := c.Restore(saved, RestoreOptions{Libraries: current})
	if err != nil {
		t.Fatal(err)
	}
	if result.VariablesOnly || len(result.Reloaded) != 0 {
		t.Fatal(result)
	}
	if got := restored.Libraries(); len(got) != 2 || got[0] != current[0] || got[1] != current[1] {
		t.Fatal(got)
	}
	if _, _, err := c.Restore(saved, RestoreOptions{Libraries: []*Library{next, wrapper}}); err == nil {
		t.Fatal("restored with the stale dependant")
	}
}
