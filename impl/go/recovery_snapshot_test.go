package northtalk

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

func recoveryFixtures(t *testing.T) []struct{ Name, Source string } {
	t.Helper()
	var all []struct{ Name, Source string }
	for _, path := range []string{"../../tools/machine/recovery-cases.json", "../../tools/machine/recovery-nested-cases.json"} {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		var cases []struct{ Name, Source string }
		if err := json.Unmarshal(data, &cases); err != nil {
			t.Fatal(err)
		}
		all = append(all, cases...)
	}
	return all
}
func recoveryOutput(lines []string) []string {
	out := []string{}
	for _, l := range lines {
		if !strings.HasPrefix(l, "> save ") && !strings.HasPrefix(l, "> restore ") {
			out = append(out, l)
		}
	}
	return out
}
func TestRecoverySnapshotEveryBoundary(t *testing.T) {
	for _, fixture := range recoveryFixtures(t) {
		for _, options := range []PumpOptions{{FuelSlice: 1}, {FuelSlice: 7, FuelCap: 3}} {
			t.Run(fmt.Sprintf("%s/%+v", fixture.Name, options), func(t *testing.T) {
				original, resumed := []string{}, []string{}
				core := New()
				g := core.NewGroup(GroupOptions{Name: "snapshot", Trace: traceFunc(func(l string) { original = append(original, l) })})
				s, err := g.Load(LoadOptions{Name: "s", Source: fixture.Source})
				if err != nil {
					t.Fatal(err)
				}
				if _, err := s.Deliver(Message{Name: "go"}); err != nil {
					t.Fatal(err)
				}
				restoreOptions := RestoreOptions{Trace: traceFunc(func(l string) { resumed = append(resumed, l) })}
				saved, err := g.Save()
				if err != nil {
					t.Fatal(err)
				}
				copy, _, err := core.Restore(saved, restoreOptions)
				if err != nil {
					t.Fatal(err)
				}
				for step := range 4000 {
					original, resumed = nil, nil
					a, err := g.Pump(time.Unix(0, int64(step)), options)
					if err != nil {
						t.Fatal(err)
					}
					b, err := copy.Pump(time.Unix(0, int64(step)), options)
					if err != nil {
						t.Fatal(err)
					}
					a.Reports = operationalReports(a.Reports)
					b.Reports = operationalReports(b.Reports)
					if !reflect.DeepEqual(a, b) || !reflect.DeepEqual(recoveryOutput(original), recoveryOutput(resumed)) || !reflect.DeepEqual(g.Inspect(), copy.Inspect()) {
						t.Fatalf("step %d differs\noriginal=%v\nrestored=%v", step, original, resumed)
					}
					saved, err = g.Save()
					if err != nil {
						t.Fatal(err)
					}
					other, err := copy.Save()
					if err != nil {
						t.Fatal(err)
					}
					// Private codec contains locals, retained PCs/stacks, cleanup, attempts,
					// rollback base and debt as well as the public inspection.
					if !bytes.Equal(saved, other) {
						t.Fatalf("step %d snapshot differs", step)
					}
					copy, _, err = core.Restore(saved, restoreOptions)
					if err != nil {
						t.Fatalf("step %d: %v", step, err)
					}
					if a.State == Idle {
						return
					}
				}
				t.Fatal("Recovery did not finish")
			})
		}
	}
}

const recoveryCleanupSource = `function fail
 try
  try
   throw "bad"
  finally
   put 1 into x
  end try
 finally
  put 2 into x
 end try
end fail
function work
 try
  return fail()
 offer recover value
  return value
 end try
end work
on go
 try
  return work()
 catch "bad" before unwind
  choose offer recover(7)
 end try
end go`

func recoverySnapshotIn(t *testing.T, phase string) []byte {
	t.Helper()
	source := recoveryCleanupSource
	if phase == "nested" {
		source = ""
		for _, f := range recoveryFixtures(t) {
			if f.Name == "nested recovery: nested policy catch cannot see original offers" {
				source = f.Source
			}
		}
	}
	if phase == "catch" {
		source = strings.Replace(source, "catch \"bad\" before unwind\n  choose offer recover(7)", "catch \"bad\"\n  return 7", 1)
	}
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: source})
	if err != nil {
		t.Fatal(err)
	}
	s.Deliver(Message{Name: "go"})
	for step := range 300 {
		if _, err := g.Pump(time.Unix(0, int64(step)), PumpOptions{FuelCap: 1}); err != nil {
			t.Fatal(err)
		}
		if len(s.runs) == 0 || len(s.runs[0].run.Recoveries) == 0 {
			continue
		}
		run := s.runs[0].run
		c := run.Recoveries[len(run.Recoveries)-1]
		found := phase == "nested" && len(run.Recoveries) == 2 || phase == "selection" && c.Pending == nil || c.Pending != nil && c.Pending.Kind == phase
		if found {
			saved, err := g.Save()
			if err != nil {
				t.Fatal(err)
			}
			return saved
		}
	}
	t.Fatalf("Missing snapshot phase %s", phase)
	return nil
}
func TestMalformedRecoverySnapshot(t *testing.T) {
	type object = map[string]any
	cases := []struct {
		name, phase string
		change      func(run, c object)
	}{
		{"retained code identity", "selection", func(r, c object) { c["Retained"].([]any)[0].(object)["Code"] = object{"$ref": "unknown"} }},
		{"retained body", "selection", func(r, c object) { c["Retained"].([]any)[0].(object)["Body"] = 999 }},
		{"retained PC", "selection", func(r, c object) { c["Retained"].([]any)[0].(object)["PC"] = -1 }},
		{"retained local layout", "selection", func(r, c object) { c["Retained"].([]any)[0].(object)["Locals"] = nil }},
		{"inconsistent owner locals", "selection", func(r, c object) {
			locals := c["Retained"].([]any)[0].(object)["Locals"].([]any)
			locals[0].(object)["Text"] = "forged"
		}},
		{"activation PC", "selection", func(r, c object) { c["Activation"].(object)["PC"] = -1 }},
		{"owner cycle", "selection", func(r, c object) { a := c["Activation"].(object); a["OwnerID"] = a["ID"] }},
		{"control cycle", "selection", func(r, c object) { a := c["Activation"].(object); a["ControlID"] = a["ID"] }},
		{"missing owner", "selection", func(r, c object) { c["Activation"].(object)["OwnerID"] = 0 }},
		{"cancellation phase", "selection", func(r, c object) { r["Cancelling"] = true }},
		{"cursor", "selection", func(r, c object) { c["Cursor"] = 999 }},
		{"try table", "selection", func(r, c object) { c["Entry"].(object)["Target"] = 999 }},
		{"phase", "offer", func(r, c object) { c["Pending"].(object)["Kind"] = "search" }},
		{"target PC", "offer", func(r, c object) { c["Pending"].(object)["PC"] = 0 }},
		{"target argument count", "offer", func(r, c object) { c["Pending"].(object)["Args"] = nil }},
		{"target slot", "offer", func(r, c object) { c["Pending"].(object)["Binds"] = []any{999} }},
		{"attempt counter rewind", "offer", func(r, c object) { r["OfferAttempt"] = 0 }},
		{"pending attempt", "offer", func(r, c object) { c["Pending"].(object)["Attempt"] = 99 }},
		{"frame counter rewind", "offer", func(r, c object) { r["FrameCounter"] = 0 }},
		{"cleanup reference", "offer", func(r, c object) { c["CleanupEntry"].(object)["Target"] = 999 }},
		{"cleanup phase", "offer", func(r, c object) { c["CleanupEntry"] = nil }},
		{"cleanup index", "offer", func(r, c object) { c["Queue"].([]any)[0].(object)["Index"] = 999 }},
		{"duplicate cleanup", "offer", func(r, c object) { queue := c["Queue"].([]any); c["Queue"] = append(queue, queue[0]) }},
		{"catch target", "catch", func(r, c object) { c["Pending"].(object)["PC"] = 0 }},
		{"nested boundary cycle", "nested", func(r, c object) { c["Boundary"].(object)["Outer"].(object)["ID"] = c["ID"] }},
		{"seen catch", "selection", func(r, c object) {
			id := fmt.Sprint(c["Retained"].([]any)[0].(object)["ID"])
			c["Seen"] = object{id: object{"999": true}}
		}},
		{"excluded scope", "selection", func(r, c object) {
			id := fmt.Sprint(c["Retained"].([]any)[0].(object)["ID"])
			c["Excluded"] = object{id: object{"finally:999": true}}
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			saved := recoverySnapshotIn(t, tc.phase)
			broken := rewriteSave(t, saved, func(data map[string]any) {
				run := data["Scripts"].([]any)[0].(object)["Runs"].([]any)[0].(object)["Run"].(object)
				contexts := run["Recoveries"].([]any)
				tc.change(run, contexts[len(contexts)-1].(object))
			})
			_, _, err := New().Restore(broken, RestoreOptions{})
			host, ok := err.(*HostError)
			if !ok || host.Code != InvalidSave {
				t.Fatalf("malformed snapshot accepted: %v", err)
			}
		})
	}
}

func TestCancelledRecoverySnapshotEveryCleanupBoundary(t *testing.T) {
	for _, phase := range []string{"selection", "offer", "catch", "nested"} {
		t.Run(phase, func(t *testing.T) {
			saved := recoverySnapshotIn(t, phase)
			original, resumed := []string{}, []string{}
			core := New()
			settings := RestoreOptions{Trace: traceFunc(func(l string) { original = append(original, l) })}
			g, _, err := core.Restore(saved, settings)
			if err != nil {
				t.Fatal(err)
			}
			settings.Trace = traceFunc(func(l string) { resumed = append(resumed, l) })
			copy, _, err := core.Restore(saved, settings)
			if err != nil {
				t.Fatal(err)
			}
			g.Script("s").CancelRun("s/r1")
			copy.Script("s").CancelRun("s/r1")
			for step := range 300 {
				original, resumed = nil, nil
				now := time.Unix(0, 10000+int64(step))
				a, err := g.Pump(now, PumpOptions{FuelSlice: 1})
				if err != nil {
					t.Fatal(err)
				}
				b, err := copy.Pump(now, PumpOptions{FuelSlice: 1})
				if err != nil {
					t.Fatal(err)
				}
				a.Reports = operationalReports(a.Reports)
				b.Reports = operationalReports(b.Reports)
				if !reflect.DeepEqual(a, b) || !reflect.DeepEqual(recoveryOutput(original), recoveryOutput(resumed)) || !reflect.DeepEqual(g.Inspect(), copy.Inspect()) {
					t.Fatalf("step %d differs\noriginal=%v\nrestored=%v", step, original, resumed)
				}
				saved, err = g.Save()
				if err != nil {
					t.Fatal(err)
				}
				other, err := copy.Save()
				if err != nil {
					t.Fatal(err)
				}
				if !bytes.Equal(saved, other) {
					t.Fatalf("step %d snapshot differs", step)
				}
				copy, _, err = core.Restore(saved, settings)
				if err != nil {
					t.Fatalf("step %d: %v", step, err)
				}
				if a.State == Idle {
					return
				}
			}
			t.Fatal("Cancellation did not finish")
		})
	}
}

func TestLibraryRecoverySnapshotEveryBoundary(t *testing.T) {
	read := func(file string) string {
		data, err := os.ReadFile("../../corpus/recovery-offers/basic/" + file)
		if err != nil {
			t.Fatal(err)
		}
		return string(data)
	}
	core := New()
	libraries := []*Library{}
	for _, name := range []string{"rows", "wrapper"} {
		library, err := core.CompileLibrary(LibrarySource{Name: name, Version: "1", Source: read(name + ".talk")}, libraries, nil)
		if err != nil {
			t.Fatal(err)
		}
		libraries = append(libraries, library)
	}
	original, resumed, choices := []string{}, []string{}, []string{}
	g := core.NewGroup(GroupOptions{Name: "snapshot", Trace: traceFunc(func(l string) { original = append(original, l) })})
	for _, l := range libraries {
		if err := g.AddLibrary(l); err != nil {
			t.Fatal(err)
		}
	}
	s, err := g.Load(LoadOptions{Name: "reader", Source: read("reader.talk")})
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"skipRows", "replaceRows", "checkChoices"} {
		s.Deliver(Message{Name: name})
	}
	settings := RestoreOptions{Libraries: libraries, Trace: traceFunc(func(l string) { resumed = append(resumed, l) })}
	saved, err := g.Save()
	if err != nil {
		t.Fatal(err)
	}
	copy, _, err := core.Restore(saved, settings)
	if err != nil {
		t.Fatal(err)
	}
	for step := range 2000 {
		original, resumed = nil, nil
		a, err := g.Pump(time.Unix(0, int64(step)), PumpOptions{FuelSlice: 1})
		if err != nil {
			t.Fatal(err)
		}
		b, err := copy.Pump(time.Unix(0, int64(step)), PumpOptions{FuelSlice: 1})
		if err != nil {
			t.Fatal(err)
		}
		a.Reports = operationalReports(a.Reports)
		b.Reports = operationalReports(b.Reports)
		if !reflect.DeepEqual(a, b) || !reflect.DeepEqual(recoveryOutput(original), recoveryOutput(resumed)) || !reflect.DeepEqual(g.Inspect(), copy.Inspect()) {
			t.Fatalf("step %d differs\noriginal=%v\nrestored=%v", step, original, resumed)
		}
		for _, l := range original {
			if strings.HasPrefix(l, "offer-chosen") {
				choices = append(choices, strings.Join(strings.Split(l, " ")[1:3], " "))
			}
		}
		saved, err = g.Save()
		if err != nil {
			t.Fatal(err)
		}
		other, err := copy.Save()
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(saved, other) {
			t.Fatalf("step %d snapshot differs", step)
		}
		copy, _, err = core.Restore(saved, settings)
		if err != nil {
			t.Fatalf("step %d: %v", step, err)
		}
		if a.State == Idle {
			if !reflect.DeepEqual(choices, []string{"reader/r1 attempt=1", "reader/r2 attempt=1", "reader/r3 attempt=1", "reader/r3 attempt=2"}) {
				t.Fatal(choices)
			}
			vars := []string{}
			for _, pair := range g.Inspect().Scripts[0].Vars {
				vars = append(vars, pair.Val.String())
			}
			if !reflect.DeepEqual(vars, []string{"[5, 7]", "[5, 0, 7]", "[0, 0]", "\"ccccccuacuac\""}) {
				t.Fatal(vars)
			}
			return
		}
	}
	t.Fatal("Library recovery did not finish")
}

func TestRecoverySaveFormatRejectsPriorTransferLayout(t *testing.T) {
	saved, err := New().NewGroup(GroupOptions{}).Save()
	if err != nil {
		t.Fatal(err)
	}
	saved = rewriteSave(t, saved, func(data map[string]any) { data["Format"] = "go/1" })
	_, _, err = New().Restore(saved, RestoreOptions{})
	host, ok := err.(*HostError)
	if !ok || host.Code != InvalidSave {
		t.Fatalf("prior transfer layout accepted: %v", err)
	}
}
