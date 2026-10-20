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

// Public observations contain opaque Values. Compare those by value semantics,
// not by private backing buffers, spare capacity or memoized logical sizes.
// Other fields retain DeepEqual's exact comparison, including nil slices.
func snapshotObservationEqual(a, b any) bool {
	var equal func(reflect.Value, reflect.Value) bool
	equal = func(a, b reflect.Value) bool {
		if !a.IsValid() || !b.IsValid() {
			return a.IsValid() == b.IsValid()
		}
		if a.Type() != b.Type() {
			return false
		}
		if v, ok := a.Interface().(Value); ok {
			return v.Equal(b.Interface().(Value))
		}
		switch a.Kind() {
		case reflect.Pointer, reflect.Interface:
			if a.IsNil() || b.IsNil() {
				return a.IsNil() == b.IsNil()
			}
			return equal(a.Elem(), b.Elem())
		case reflect.Slice:
			if a.IsNil() != b.IsNil() || a.Len() != b.Len() {
				return false
			}
			for i := range a.Len() {
				if !equal(a.Index(i), b.Index(i)) {
					return false
				}
			}
			return true
		case reflect.Struct:
			for i := range a.NumField() {
				if !a.Field(i).CanInterface() {
					return reflect.DeepEqual(a.Interface(), b.Interface())
				}
				if !equal(a.Field(i), b.Field(i)) {
					return false
				}
			}
			return true
		default:
			return reflect.DeepEqual(a.Interface(), b.Interface())
		}
	}
	return equal(reflect.ValueOf(a), reflect.ValueOf(b))
}
func TestRecoverySnapshotEveryBoundary(t *testing.T) {
	skipUnderRace(t)
	for _, fixture := range recoveryFixtures(t) {
		for _, options := range []PumpOptions{{FuelSlice: 1}, {FuelSlice: 7, FuelCap: 3}} {
			t.Run(fmt.Sprintf("%s/%+v", fixture.Name, options), func(t *testing.T) {
				t.Parallel()
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
					if !snapshotObservationEqual(a, b) || !reflect.DeepEqual(recoveryOutput(original), recoveryOutput(resumed)) || !snapshotObservationEqual(g.Inspect(), copy.Inspect()) {
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

// recoverySnapshots saves the Group before every 1-Fuel step of source's go
// Run, so the saves land on each recovery cleanup boundary: selection, offer,
// catch and nested.
func recoverySnapshots(t *testing.T, source string) [][]byte {
	t.Helper()
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: source})
	if err != nil {
		t.Fatal(err)
	}
	s.Deliver(Message{Name: "go"})
	saves := [][]byte{}
	for step := range 300 {
		result, err := g.Pump(time.Unix(0, int64(step)), PumpOptions{FuelCap: 1})
		if err != nil {
			t.Fatal(err)
		}
		if result.State == Idle {
			return saves
		}
		saved, err := g.Save()
		if err != nil {
			t.Fatal(err)
		}
		saves = append(saves, saved)
	}
	t.Fatal("go Run did not finish")
	return nil
}

func TestCancelledRecoverySnapshotEveryCleanupBoundary(t *testing.T) {
	sources := map[string]string{
		"cleanup": recoveryCleanupSource,
		"catch":   strings.Replace(recoveryCleanupSource, "catch \"bad\" before unwind\n  choose offer recover(7)", "catch \"bad\"\n  return 7", 1),
	}
	for _, f := range recoveryFixtures(t) {
		if f.Name == "nested recovery: nested policy catch cannot see original offers" {
			sources["nested"] = f.Source
		}
	}
	for name, source := range sources {
		for i, saved := range recoverySnapshots(t, source) {
			t.Run(fmt.Sprint(name, "/", i), func(t *testing.T) {
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
					if !snapshotObservationEqual(a, b) || !reflect.DeepEqual(recoveryOutput(original), recoveryOutput(resumed)) || !snapshotObservationEqual(g.Inspect(), copy.Inspect()) {
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
}

func TestLibraryRecoverySnapshotEveryBoundary(t *testing.T) {
	skipUnderRace(t)
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
		if !snapshotObservationEqual(a, b) || !reflect.DeepEqual(recoveryOutput(original), recoveryOutput(resumed)) || !snapshotObservationEqual(g.Inspect(), copy.Inspect()) {
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
