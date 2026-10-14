package northtalk

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/odogono/odgn-talk/impl/go/internal/value"
)

type restrictedCase struct {
	Name, Source, Result            string
	FuelLimit                       int64
	AllocLimit                      int64
	DepthLimit                      int
	Object, Disposed, Foreign, Host bool
}

func restrictedSetup(t *testing.T, c restrictedCase, lines *[]string) *Group {
	t.Helper()
	g := New().NewGroup(GroupOptions{Name: "restricted", Trace: traceFunc(func(s string) { *lines = append(*lines, s) })})
	options := LoadOptions{Name: "s", Source: c.Source, Limits: Limits{FuelPerRun: c.FuelLimit, AllocPerRun: c.AllocLimit, CallDepth: c.DepthLimit}}
	if c.Host {
		cap, err := g.core.DefineCapability("restrictedApi",
			Operation{Name: "read", Mode: Immediate, Args: []Shape{NumberShape}, Result: NumberShape, Cost: Cost{Fuel: 11}, Do: func(*Call, []Value) (Value, error) { t.Fatal("Host read occurred"); return Nothing, nil }},
			Operation{Name: "write", Mode: FireAndForget, Args: []Shape{NumberShape}, Cost: Cost{Fuel: 11}, Fire: func(*Call, []Value) error { t.Fatal("Host write occurred"); return nil }})
		if err != nil {
			t.Fatal(err)
		}
		options.Grants = map[string]*Grant{"api": cap.GrantAll(nil)}
	}
	s, err := g.Load(options)
	if err != nil {
		t.Fatal(err)
	}
	lib := standardLibraries()["map"].state
	body := -1
	for i, b := range lib.Unit.Bodies {
		if b.Checked.Name == "restrictedCall" {
			body = i
		}
	}
	if body < 0 {
		t.Fatal("missing private intrinsic")
	}
	// Test-only construction of a private Function Value, never a public import.
	fn := Value{inner: value.Fields{Kind: value.Function, Function: &value.FunctionData{
		Home: "s", Code: "map:restrictedCall", CodeState: lib, Body: body, Owner: s.state,
		Group: s.state.Group, Name: "restrictedCall", Required: 2, Total: 2,
	}}.Value()}
	args := []Value{fn}
	if c.Object {
		kind, err := g.core.DefineObjectKind(ObjectKindDef{Name: "item", Props: []Prop{{Name: "label", Shape: TextShape,
			Get: func(*Object) (Value, error) { t.Fatal("Host getter occurred"); return Nothing, nil },
			Set: func(*Object, Value) error { t.Fatal("Host setter occurred"); return nil }}}})
		if err != nil {
			t.Fatal(err)
		}
		o, err := g.Object(kind, "o1", nil)
		if err != nil {
			t.Fatal(err)
		}
		if c.Disposed {
			g.Dispose(o)
			g.Pump(time.Unix(0, 0), PumpOptions{})
		}
		args = append(args, o.Value())
	}
	if c.Foreign {
		other, err := g.Load(LoadOptions{Name: "other", Source: "function callback n\n return n\nend callback\n"})
		if err != nil {
			t.Fatal(err)
		}
		args = append(args, Value{inner: value.Fields{Kind: value.Function, Function: &value.FunctionData{Home: "other", Code: "callback", CodeState: other.state, Body: 1, Owner: other.state, Group: other.state.Group, Name: "callback", Required: 1, Total: 1}}.Value()})
	}
	*lines = nil
	if _, err := s.Deliver(Message{Name: "go", Args: args}); err != nil {
		t.Fatal(err)
	}
	return g
}

func TestRestrictedCallbackKit(t *testing.T) {
	root := "../../corpus/restricted-kit"
	raw, err := os.ReadFile(filepath.Join(root, "cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cases []restrictedCase
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			var lines []string
			g := restrictedSetup(t, c, &lines)
			if _, err := g.Pump(time.Unix(0, 0), PumpOptions{}); err != nil {
				t.Fatal(err)
			}
			g.Inspect()
			want, err := os.ReadFile(filepath.Join(root, c.Name+".trace"))
			if err != nil {
				t.Fatal(err)
			}
			got := strings.Join(lines, "\n") + "\n"
			if strings.HasPrefix(string(want), "# ") {
				_, want, _ = bytes.Cut(want, []byte("\n"))
			}
			if got != string(want) {
				t.Fatalf("Trace mismatch\nwant:\n%s\ngot:\n%s", want, got)
			}
		})
	}
}

func TestRestrictedCallbackRestoreEveryInstruction(t *testing.T) {
	raw, err := os.ReadFile("../../corpus/restricted-kit/cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []restrictedCase
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			var lines, copied []string
			original := restrictedSetup(t, c, &lines)
			original.Pump(time.Unix(0, 0), PumpOptions{FuelSlice: 1})
			for step := 0; step < 1000; step++ {
				saved, err := original.Save()
				if err != nil {
					t.Fatal(err)
				}
				copy, _, err := original.core.Restore(saved, RestoreOptions{Trace: traceFunc(func(s string) { copied = append(copied, s) }), Resolve: func(string, string) (any, bool) { return nil, true }, Grants: func(script, name string) *Grant { return original.Script(script).grants[name] }})
				if err != nil {
					t.Fatal(err)
				}
				lines, copied = nil, nil
				a, err := original.Pump(time.Unix(0, 0), PumpOptions{FuelSlice: 1})
				if err != nil {
					t.Fatal(err)
				}
				b, err := copy.Pump(time.Unix(0, 0), PumpOptions{FuelSlice: 1})
				if err != nil {
					t.Fatal(err)
				}
				if a.State != b.State || a.FuelUsed != b.FuelUsed || !reflect.DeepEqual(lines, copied) {
					t.Fatalf("step %d diverged\n%v\n%v", step, lines, copied)
				}
				original.Inspect()
				copy.Inspect()
				if !reflect.DeepEqual(lines, copied) {
					t.Fatal("restored state differs")
				}
				if a.State == Idle {
					return
				}
			}
			t.Fatal("did not finish")
		})
	}
}

func TestRestrictedIntrinsicAccess(t *testing.T) {
	if _, err := New().NewGroup(GroupOptions{}).Load(LoadOptions{Name: "private", Source: "use restrictedCall from map\n"}); err == nil {
		t.Fatal("private intrinsic imported")
	}
	trusted := standardLibraries()["map"]
	host, err := New().CompileLibrary(trusted.source, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, b := range host.state.Unit.Bodies {
		for _, i := range b.Code {
			if i.Name == "call-restricted" {
				t.Fatal("Host source gained trust")
			}
		}
	}
	want, err := os.ReadFile("../../corpus/restricted-kit/map.dis")
	if err != nil {
		t.Fatal(err)
	}
	if got := trusted.state.Unit.Disassemble(); got != string(want) {
		t.Fatal("trusted disassembly differs")
	}
	if _, ok := trusted.exports["restrictedCall"]; ok {
		t.Fatal("private intrinsic exported")
	}
}
