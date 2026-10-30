package northtalk

import (
	"errors"
	"testing"
	"time"

	"northtalk.org/go/internal/replay"
)

// The Corpus obtains replacement Libraries through this hook before Restore.
// A stale handle here silently turns a requested variables-only restore into full.
func TestLibraryReplayAfterReplacement(t *testing.T) {
	for _, tc := range []struct {
		name       string
		transitive bool
	}{{"direct", false}, {"transitive", true}} {
		t.Run(tc.name, func(t *testing.T) {
			core := New()
			compile := func(name, source string, imports ...*Library) *Library {
				t.Helper()
				l, err := core.CompileLibrary(LibrarySource{Name: name, Version: "1", Source: source}, imports, nil)
				if err != nil {
					t.Fatal(err)
				}
				return l
			}
			base := compile("base", "function label\n return 1\nend label\n")
			g := core.NewGroup(GroupOptions{})
			add := func(l *Library) {
				t.Helper()
				if err := g.AddLibrary(l); err != nil {
					t.Fatal(err)
				}
			}
			add(base)
			library, function := "base", "label"
			var wrapper *Library
			if tc.transitive {
				wrapper = compile("wrapper", "use label from base\nfunction wrapped\n return label()\nend wrapped\n", base)
				add(wrapper)
				library, function = "wrapper", "wrapped"
			}
			s, err := g.Load(LoadOptions{Name: "s", Source: "use " + function + " from " + library + "\nscript variable n = 0\non go\n put " + function + "() into n\n wait 1 s\nend go\n"})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := s.Deliver(Message{Name: "go"}); err != nil {
				t.Fatal(err)
			}
			if _, err := g.Pump(time.Unix(1, 0), PumpOptions{}); err != nil {
				t.Fatal(err)
			}
			saved, err := g.Save()
			if err != nil {
				t.Fatal(err)
			}
			selected := func() []*Library {
				t.Helper()
				var out []*Library
				for _, l := range replay.Libraries(g) {
					out = append(out, l.(*Library))
				}
				return out
			}
			assertFull := func() {
				t.Helper()
				restored, result, err := core.Restore(saved, RestoreOptions{Libraries: selected()})
				if err != nil || result.VariablesOnly || restored.Fingerprint() != g.Fingerprint() {
					t.Fatalf("matching Libraries did not restore fully: %+v, %v", result, err)
				}
			}
			assertFull()
			bad := compile("base", "function other\n return 3\nend other\n")
			if _, err := g.ReplaceLibrary(bad, CarryVariables); err == nil {
				t.Fatal("incompatible replacement accepted")
			}
			assertFull()
			// Offering an unrelated Library must not make it a dependency.
			var offered []*Library
			if tc.transitive {
				offered = append(offered, wrapper)
			}
			next := compile("base", "function label\n return 2\nend label\n", offered...)
			if _, err := g.ReplaceLibrary(next, CarryVariables); err != nil {
				t.Fatal(err)
			}
			want := map[string]*Library{"base": next}
			if tc.transitive {
				want["wrapper"] = compile("wrapper", wrapper.Source(), next)
			}
			libraries := selected()
			if len(libraries) != len(want) {
				t.Fatalf("replay holds %d Libraries, want %d", len(libraries), len(want))
			}
			for _, l := range libraries {
				if expected := want[l.Name()]; expected == nil || expected.Identity() != l.Identity() {
					t.Fatalf("replay holds stale Library %s (%x)", l.Name(), l.Identity())
				}
			}
			_, _, err = core.Restore(saved, RestoreOptions{Libraries: libraries})
			var host *HostError
			if !errors.As(err, &host) || host.Code != SaveMismatch {
				t.Fatalf("RejectMismatch accepted replacement Libraries: %v", err)
			}
			restored, result, err := core.Restore(saved, RestoreOptions{Libraries: libraries, Mismatch: VariablesOnly})
			if err != nil {
				t.Fatal(err)
			}
			if !result.VariablesOnly || len(result.Pending) != 0 || len(result.DiscardedRuns) != 1 || result.DiscardedRuns[0] != "s/r1" {
				t.Fatalf("replacement did not discard the saved Run: %+v", result)
			}
			if n := restored.Inspect().Scripts[0].Vars[0].Val; !n.Equal(Int(1)) {
				t.Fatal("restore lost the saved variable", n)
			}
			if _, err := restored.Script("s").Deliver(Message{Name: "go"}); err != nil {
				t.Fatal(err)
			}
			if _, err := restored.Pump(time.Unix(2, 0), PumpOptions{}); err != nil {
				t.Fatal(err)
			}
			if n := restored.Inspect().Scripts[0].Vars[0].Val; !n.Equal(Int(2)) {
				t.Fatal("restore did not use the replacement Library", n)
			}
		})
	}
}
