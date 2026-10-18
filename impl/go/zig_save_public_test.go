package northtalk_test

import (
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	talk "github.com/odogono/odgn-talk/impl/go"
)

func runSaveBridgeCases(t *testing.T) []bridgeObservation {
	var observations []bridgeObservation
	for _, name := range []string{"answer", "fail", "adopt", "reissue", "mismatch", "variables only", "handles", "preempted", "refusals", "reentrant", "unresolved object", "library", "invalid save", "invalid policy", "nil Library"} {
		t.Run("save "+name, func(t *testing.T) {
			o := bridgeObservation{Name: "save " + name}
			var trace bridgeTrace
			core := talk.New()
			code := func(err error) {
				if err == nil {
					o.Values = append(o.Values, "ok")
					return
				}
				if h, ok := err.(*talk.HostError); ok {
					o.Values = append(o.Values, string(h.Code))
					return
				}
				t.Fatal(err)
			}
			value := func(v any) { o.Pumps = append(o.Pumps, bridgeCanonical(reflect.ValueOf(v))) }
			pump := func(g *talk.Group, now time.Time, opts talk.PumpOptions) {
				r, err := g.Pump(now, opts)
				if err != nil {
					t.Fatal(err)
				}
				value(r)
				value(g.Inspect())
			}
			var g *talk.Group
			starts := 0
			var original *talk.Call
			op := talk.Operation{Name: "fetch", Args: []talk.Shape{talk.ValueShape}, Result: talk.ValueShape, Mode: talk.Suspending, Cost: talk.Cost{Fuel: 7}, Start: func(c *talk.Call, args []talk.Value) error {
				starts++
				if name == "reentrant" {
					_, err := g.Save()
					code(err)
					if !isReentrant(err) {
						t.Fatal(err)
					}
				}
				original = c
				o.Calls = append(o.Calls, fmt.Sprintf("%s %s %s %s %v", c.ID(), c.RunID(), c.SegmentID(), c.Now().Format(time.RFC3339Nano), args))
				if starts > 1 {
					if !c.Now().Equal(bridgeNow.Add(time.Second)) || c.SegmentID() != "s/r1.s1" {
						t.Fatal("reissued Call lost its Segment or Pump Clock", c.SegmentID(), c.Now())
					}
					c.AnswerWithCost(talk.Int(41), 3)
				}
				return nil
			}}
			def, err := core.DefineCapability("service", op)
			if err != nil {
				t.Fatal(err)
			}
			grant := def.GrantAll("binding")
			g = core.NewGroup(talk.GroupOptions{Trace: &trace})
			source := "script variable n = 0\non go\n ask api to fetch 4 and wait\n put it into n\n return n\nend go\non read\n return n\nend read\n"
			options := talk.LoadOptions{Name: "s", Source: source, Grants: map[string]*talk.Grant{"api": grant}}
			var object *talk.Object
			if name == "handles" || name == "unresolved object" {
				kind, err := core.DefineObjectKind(talk.ObjectKindDef{Name: "item", Props: []talk.Prop{{Name: "n", Shape: talk.NumberShape, Get: func(o *talk.Object) (talk.Value, error) { return talk.Int(int64(o.Native().(int))), nil }}}})
				if err != nil {
					t.Fatal(err)
				}
				object, err = g.Object(kind, "one", 5)
				if err != nil {
					t.Fatal(err)
				}
				options.Objects = map[string]*talk.Object{"item": object}
				options.Source = "script variable obj = nothing\nscript variable fn = nothing\non go\n put item into obj\n put given x: x + the n of obj into fn\n ask api to fetch [obj, fn] and wait\n return it\nend go\non read\n return [obj, fn]\nend read\n"
			}
			var libraries []*talk.Library
			if name == "library" {
				lib, err := core.CompileLibrary(talk.LibrarySource{Name: "maths", Source: "function twice n\n return n * 2\nend twice\n"}, nil, nil)
				if err != nil {
					t.Fatal(err)
				}
				if err := g.AddLibrary(lib); err != nil {
					t.Fatal(err)
				}
				libraries = []*talk.Library{lib}
				options.Source = "use twice from maths\n" + strings.ReplaceAll(options.Source, "put it into n", "put twice(it) into n")
			}
			if name == "preempted" {
				options.Source = "script variable n = 0\non go\n add 1 to n\n repeat forever\n end repeat\nend go\non read\n return n\nend read\n"
				options.Limits = talk.Limits{FuelPerRun: 100}
			}
			s, err := g.Load(options)
			if err != nil {
				t.Fatal(err)
			}
			_, future, err := s.Request(nil, talk.Message{Name: "go"})
			if err != nil {
				t.Fatal(err)
			}
			opts := talk.PumpOptions{}
			if name == "preempted" {
				opts.FuelSlice = 20
			}
			pump(g, bridgeNow, opts)
			if name == "adopt" || name == "reissue" {
				pump(g, bridgeNow.Add(123456*time.Microsecond), talk.PumpOptions{})
				pump(g, bridgeNow.Add(654321*time.Microsecond), talk.PumpOptions{})
			}
			fingerprint := g.Fingerprint()
			saved, err := g.Save()
			if err != nil {
				t.Fatal(err)
			}
			if g.Fingerprint() != fingerprint {
				t.Fatal("Save changed Fingerprint")
			}
			select {
			case <-future.Done():
				t.Fatal("Save settled original future")
			default:
			}
			resolve := talk.RestoreOptions{Trace: &trace, Libraries: libraries, Grants: func(script, name string) *talk.Grant {
				o.Values = append(o.Values, "grant "+script+" "+name)
				return grant
			}, Resolve: func(kind, id string) (any, bool) {
				o.Values = append(o.Values, "object "+kind+" "+id)
				return 9, name != "unresolved object"
			}}
			if name == "mismatch" || name == "variables only" {
				op.Cost.Fuel++
				changed, err := core.DefineCapability("service", op)
				if err != nil {
					t.Fatal(err)
				}
				resolve.Grants = func(string, string) *talk.Grant { return changed.GrantAll(nil) }
				if name == "variables only" {
					resolve.Mismatch = talk.VariablesOnly
				}
			}
			if name == "invalid save" {
				saved = []byte("not a save")
			}
			if name == "invalid policy" {
				resolve.Mismatch = 999
			}
			if name == "nil Library" {
				resolve.Libraries = []*talk.Library{nil}
			}
			restored, result, err := core.Restore(saved, resolve)
			code(err)
			if name == "mismatch" || strings.HasPrefix(name, "invalid") || name == "nil Library" {
				if err == nil {
					t.Fatal("changed declaration restored")
				}
				o.Trace = trace.lines
				observations = append(observations, o)
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			value(result)
			if name != "variables only" && restored.Fingerprint() != fingerprint {
				t.Fatal("restore changed Fingerprint")
			}
			if restored.Script("s") == nil || !reflect.DeepEqual(restored.ScriptNames(), []string{"s"}) {
				t.Fatal("missing restored Script")
			}
			value(restored.Script("s").Grants())
			value(restored.Inspect())
			if name == "handles" {
				h, ok := restored.ObjectByID("item", "one")
				if !ok || h == object || h.Native() != 9 {
					t.Fatal("Object was not rebound")
				}
				if len(result.Pending) != 1 || len(result.Pending[0].Args) != 1 {
					t.Fatal(result.Pending)
				}
				answer := talk.Int(42)
				if _, err := restored.Settle(result.Pending[0].ID, talk.Settlement{Answer: &answer}); err != nil {
					t.Fatal(err)
				}
				fn := result.Pending[0].Args[0].Index(2)
				_, p, err := restored.Call(nil, fn, []talk.Value{talk.Int(2)}, nil)
				if err != nil {
					t.Fatal(err)
				}
				pump(restored, bridgeNow, talk.PumpOptions{})
				v, e := p.Result()
				if e != nil || !v.Equal(talk.Int(11)) {
					t.Fatal(v, e)
				}
				value(v)
			} else if len(result.Pending) > 0 {
				id := result.Pending[0].ID
				answer := talk.Int(42)
				settlement := talk.Settlement{Answer: &answer}
				switch name {
				case "fail":
					settlement = talk.Settlement{Fail: &talk.ScriptError{Code: "offline"}}
				case "adopt":
					settlement = talk.Settlement{Adopt: true}
				case "reissue":
					settlement = talk.Settlement{Reissue: true}
				case "refusals":
					_, e := restored.Settle("absent", settlement)
					code(e)
				}
				call, e := restored.Settle(id, settlement)
				code(e)
				if e != nil {
					t.Fatal(e)
				}
				if name == "adopt" {
					if call == nil || call == original || call.Group() != restored || call.Binding() != "binding" || call.Context().Err() != nil {
						t.Fatal("invalid adopted Call")
					}
					if !call.Now().Equal(bridgeNow) || call.SegmentID() != original.SegmentID() {
						t.Fatal("adopted Call lost its original Segment or Clock", call.SegmentID(), call.Now())
					}
					o.Calls = append(o.Calls, fmt.Sprintf("%s %s %s %s", call.ID(), call.RunID(), call.SegmentID(), call.Now().Format(time.RFC3339Nano)))
					code(call.Charge(1))
					call.AnswerWithCost(answer, 3)
				}
				_, e = restored.Settle(id, settlement)
				code(e)
				pump(restored, bridgeNow.Add(time.Second), talk.PumpOptions{})
				pump(restored, bridgeNow.Add(time.Second), talk.PumpOptions{})
				_, e = restored.Settle(id, talk.Settlement{Adopt: true})
				code(e)
			} else {
				pump(restored, bridgeNow.Add(time.Second), talk.PumpOptions{})
			}
			_, p, err := restored.Script("s").Request(nil, talk.Message{Name: "read"})
			if err != nil {
				t.Fatal(err)
			}
			pump(restored, bridgeNow.Add(time.Second), talk.PumpOptions{})
			select {
			case <-p.Done():
				v, e := p.Result()
				value(v)
				value(e)
			default:
				t.Fatal("restored future did not settle")
			}
			o.Trace = trace.lines
			observations = append(observations, o)
		})
	}
	return observations
}

// A transport handle must never become part of a declaration's identity.
// Loading in reverse order assigns different guest handles to the same public
// definitions, including two definitions with one public Capability name.
func TestPersistenceFingerprintRegistrationOrder(t *testing.T) {
	core := talk.New()
	define := func(n int64) *talk.Grant {
		def, err := core.DefineCapability("service", talk.Operation{Name: "read", Result: talk.NumberShape, Cost: talk.Cost{Fuel: n}, Do: func(c *talk.Call, _ []talk.Value) (talk.Value, error) {
			if c.Binding() != n {
				t.Fatal("restored binding changed", c.Binding())
			}
			return talk.Int(n), nil
		}})
		if err != nil {
			t.Fatal(err)
		}
		return def.GrantAll(n)
	}
	grants := map[string]*talk.Grant{"a": define(1), "z": define(2)}
	makeGroup := func(names []string) *talk.Group {
		g := core.NewGroup(talk.GroupOptions{})
		for _, name := range names {
			if _, err := g.Load(talk.LoadOptions{Name: name, Source: "on go\n ask api to read\n return it\nend go\n", Grants: map[string]*talk.Grant{"api": grants[name]}}); err != nil {
				t.Fatal(err)
			}
		}
		return g
	}
	g := makeGroup([]string{"z", "a"})
	if g.Fingerprint() != makeGroup([]string{"a", "z"}).Fingerprint() {
		t.Fatal("registration order changed Fingerprint")
	}
	saved, err := g.Save()
	if err != nil {
		t.Fatal(err)
	}
	restored, _, err := core.Restore(saved, talk.RestoreOptions{Grants: func(script, name string) *talk.Grant { return grants[script] }})
	if err != nil {
		t.Fatal(err)
	}
	if restored.Fingerprint() != g.Fingerprint() || !reflect.DeepEqual(restored.ScriptNames(), []string{"z", "a"}) {
		t.Fatal("restore changed identity or load order")
	}
	for _, name := range []string{"z", "a"} {
		_, p, err := restored.Script(name).Request(nil, talk.Message{Name: "go"})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := restored.Pump(bridgeNow, talk.PumpOptions{}); err != nil {
			t.Fatal(err)
		}
		v, failure := p.Result()
		want := int64(1)
		if name == "z" {
			want = 2
		}
		select {
		case <-p.Done():
		default:
			t.Fatal("restored Request did not settle")
		}
		if failure != nil || !v.Equal(talk.Int(want)) {
			t.Fatal(v, failure)
		}
	}
}
