package lower_test

import (
	"testing"

	"github.com/odogono/odgn-talk/impl/go/internal/check"
	"github.com/odogono/odgn-talk/impl/go/internal/lower"
	"github.com/odogono/odgn-talk/impl/go/internal/machine"
	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
	"github.com/odogono/odgn-talk/impl/go/internal/value"
)

func compileFenced(t *testing.T, source string) *lower.Unit {
	t.Helper()
	tree, err := syntax.Parse(source)
	if err != nil {
		t.Fatal(err)
	}
	checked := check.Check(tree, check.Options{})
	if len(checked.Diagnostics) != 0 {
		t.Fatal(checked.Diagnostics)
	}
	unit, err := lower.Compile(checked, "fenced")
	if err != nil {
		t.Fatal(err)
	}
	return unit
}

func TestFencedInterpolationExactLowering(t *testing.T) {
	unit := compileFenced(t, "on t\n return `${1}${2}x`\nend t")
	code := unit.Bodies[1].Code
	want := []struct {
		op  string
		col int
	}{
		{"const", 9}, {"const", 12}, {"concat", 10},
		{"const", 16}, {"concat", 14}, {"const", 14}, {"concat", 14},
	}
	if len(code) < len(want) {
		t.Fatalf("missing instructions:\n%s", unit.Disassemble())
	}
	for i, expected := range want {
		if code[i].Name != expected.op || code[i].Pos != (syntax.Position{Line: 2, Column: expected.col}) {
			t.Fatalf("instruction %d: want %s at 2:%d\n%s", i, expected.op, expected.col, unit.Disassemble())
		}
	}
	first := code[0].Operands()[0].Index
	if unit.Constants[first] != `""` {
		t.Fatalf("missing initial empty constant: %s", unit.Constants[first])
	}
}

func TestFencedTextRuntimeValues(t *testing.T) {
	for _, tc := range []struct{ name, expr, want string }{
		{"immediate", "`sum ${1 + 2}`", "sum 3"},
		{"nested", "`outer ${`inner ${3}`}`", "outer inner 3"},
		{"NFC across hole", "`e${\"́\"}`", "é"},
		{"insert once", "`value ${\"${missing}\"}`", "value ${missing}"},
		{"raw", `"""${missing} \n end"""`, "${missing} \\n end"},
		{"margin", "`\n  first  \n    second\n  `", "first  \n  second"},
		{"escapes", "`\\x41\\u0042\\u{1F600}\\q \\${name} \\``", "AB😀q ${name} `"},
		{"surrogate pair", "`\\uD83D\\uDE00`", "😀"},
		{"line continuation", "`\n  first\\\n  second\n  `", "firstsecond"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			unit := compileFenced(t, "constant answer = "+tc.expr+"\non go\n return answer\nend go")
			state, err := machine.Initialize(unit)
			if err != nil {
				t.Fatal(err)
			}
			run := machine.Start(state, 1, nil, machine.Limits{Fuel: 10000, Alloc: 10000, Depth: 200})
			run.Execute(0)
			if run.Status != machine.Completed || run.Result.Kind != value.Text || run.Result.Text != tc.want {
				t.Fatalf("status=%v result=%s error=%s; want %q", run.Status, run.Result.Display(), run.Error.Display(), tc.want)
			}
		})
	}
}

func TestFencedInterpolationHasConcatenationCosts(t *testing.T) {
	var runs []*machine.Run
	for _, expression := range []string{"`${1}${2}x`", `(("" & 1) & 2) & "x"`} {
		state, err := machine.Initialize(compileFenced(t, "on go\n return "+expression+"\nend go"))
		if err != nil {
			t.Fatal(err)
		}
		run := machine.Start(state, 1, nil, machine.Limits{Fuel: 10000, Alloc: 10000, Depth: 200})
		run.Execute(0)
		if run.Status != machine.Completed || run.Result.Text != "12x" {
			t.Fatalf("unexpected execution: %+v", run)
		}
		runs = append(runs, run)
	}
	if runs[0].Fuel != runs[1].Fuel || runs[0].Alloc != runs[1].Alloc {
		t.Fatalf("interpolation Fuel/Alloc %d/%d differs from concat %d/%d", runs[0].Fuel, runs[0].Alloc, runs[1].Fuel, runs[1].Alloc)
	}
}
