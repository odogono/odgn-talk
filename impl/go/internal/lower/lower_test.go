package lower

import (
	"bytes"
	"github.com/odogono/odgn-talk/impl/go/internal/check"
	"github.com/odogono/odgn-talk/impl/go/internal/generated"
	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// Corpus disassembly is the normative stream, including every source position,
// slot, constant, Unwind Table entry and event. No TS implementation is used.
func TestDisassemblyCorpus(t *testing.T) {
	files, _ := filepath.Glob("../../../../corpus/disassembly/*/*.dis")
	if len(files) != 11 {
		t.Fatalf("expected eleven units in nine cases, got %d", len(files))
	}
	emitted := map[string]bool{}
	for _, file := range files {
		t.Run(filepath.Base(filepath.Dir(file))+"/"+filepath.Base(file), func(t *testing.T) {
			source, err := os.ReadFile(strings.TrimSuffix(file, ".dis") + ".talk")
			if err != nil {
				t.Fatal(err)
			}
			tree, err := syntax.Parse(string(source))
			if err != nil {
				t.Fatal(err)
			}
			options := check.Options{Library: strings.Contains(file, "calls-and-lambdas/shapes.dis"), Objects: []string{"warehouse"}}
			if strings.HasSuffix(file, "caller.dis") {
				options.Imports = map[string]map[string]check.Symbol{
					"shapes": {"area": {Kind: "function", Required: 1, Maximum: 3}, "unit": {Kind: "definition"}},
					"list":   {"map": {Kind: "function", Required: 2, Maximum: 2}, "sortBy": {Kind: "function", Required: 2, Maximum: 4}},
					"text":   {"pad": {Kind: "function", Required: 2, Maximum: 3}},
				}
			}
			checked := check.Check(tree, options)
			if len(checked.Diagnostics) > 0 {
				t.Fatal(checked.Diagnostics)
			}
			unit, err := Compile(checked, strings.TrimSuffix(filepath.Base(file), ".dis"))
			if err != nil {
				t.Fatal(err)
			}
			again, err := Compile(checked, strings.TrimSuffix(filepath.Base(file), ".dis"))
			if err != nil || again.Disassemble() != unit.Disassemble() {
				t.Fatalf("repeated compilation changed: %v", err)
			}

			for _, body := range unit.Bodies {
				decoded, err := decodeBytecode(body.Bytecode())
				if err != nil {
					t.Fatal(err)
				}
				roundTrip := &Body{Code: decoded}
				if !bytes.Equal(body.Bytecode(), roundTrip.Bytecode()) {
					t.Fatal("bytecode changed after decoding")
				}
				for j, instruction := range body.Code {
					emitted[instruction.Name] = true
					raw := instruction
					raw.operands = nil
					if !slices.Equal(instruction.Operands(), raw.Operands()) || !slices.Equal(instruction.Operands(), decoded[j].Operands()) || instruction.Cost == "" || instruction.Cost != decoded[j].Cost || instruction.Suspends != decoded[j].Suspends {
						t.Fatalf("runtime metadata differs for %s at instruction %d", instruction.Name, j)
					}
				}
			}
			actual := unit.Disassemble()
			expected, err := os.ReadFile(file)
			if err != nil {
				t.Fatal(err)
			}
			want, got := strings.Split(string(expected), "\n"), strings.Split(actual, "\n")
			for i := 0; i < max(len(want), len(got)); i++ {
				a, b := "<end>", "<end>"
				if i < len(want) {
					a = want[i]
				}
				if i < len(got) {
					b = got[i]
				}
				if a != b {
					t.Fatalf("line %d\nexpected: %s\nactual:   %s", i+1, a, b)
				}
			}
		})
	}
	for _, entry := range generated.Machine.Instruction {
		if !emitted[entry.Name] {
			t.Errorf("Corpus does not emit %s", entry.Name)
		}
	}
}

func TestRejectedUnitCannotLower(t *testing.T) {
	tree, _ := syntax.Parse("constant x = absent")
	if unit, err := Compile(check.Check(tree, check.Options{}), "bad"); err == nil || unit != nil {
		t.Fatal("lowered invalid unit")
	}
}

func TestInvalidBytecode(t *testing.T) {
	for _, data := range [][]byte{nil, {2}, {1, 1}, {1, 0, 0}, {1, 1, 255, 255, 255, 255}} {
		if _, err := decodeBytecode(data); err == nil {
			t.Errorf("accepted %x", data)
		}
	}
}

func TestCanonicalDisplayAndParenthesizedContainer(t *testing.T) {
	for _, tc := range []struct {
		source string
		want   []string
	}{
		{"on t\nput 1 into (x)\nput 2 into item 1 of (x)\nend", []string{"store 1 ; x", "load 1 ; x"}},
		{"on t\nreturn [\"C:\\new\", \"a\tb\", 1.0 days, 2 m*kg, < <digit>>, <digit lazily ignoring case ignoring case>, <0x04 digits>, <\"a & b\">]\nend", []string{`"C:\new"`, `"a" & tab & "b"`, "1.0 day", "2 kg*m", "< <digit>>", "<digit ignoring case lazily>", "<4 digits>", `<"a & b">`}},
	} {
		tree, err := syntax.Parse(tc.source)
		if err != nil {
			t.Fatal(err)
		}
		checked := check.Check(tree, check.Options{})
		unit, err := Compile(checked, "s")
		if err != nil {
			t.Fatal(err)
		}
		actual := unit.Disassemble()
		for _, want := range tc.want {
			if !strings.Contains(actual, want) {
				t.Errorf("missing %s in\n%s", want, actual)
			}
		}
	}
	if got := quote("\r\"\u202e"); got != "fromCodePoint(13) & quote & fromCodePoint(8238)" {
		t.Fatal(got)
	}
}

func TestLowerStandardLibraries(t *testing.T) {
	files, err := filepath.Glob("../../../../spec/stdlib/*.talk")
	if err != nil || len(files) != 7 {
		t.Fatalf("stdlib: %v, files %d", err, len(files))
	}
	trees := map[string]*syntax.Tree{}
	imports := map[string]map[string]check.Symbol{}
	for _, file := range files {
		source, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		tree, err := syntax.Parse(string(source))
		if err != nil {
			t.Fatal(err)
		}
		name := strings.TrimSuffix(filepath.Base(file), ".talk")
		trees[name] = tree
		imports[name] = map[string]check.Symbol{}
		for _, declaration := range tree.Declarations {
			if declaration.Private {
				continue
			}
			symbol := check.Symbol{Kind: declaration.Kind, Name: declaration.Text, Maximum: len(declaration.Params)}
			if declaration.Kind == "constant" {
				symbol.Kind = "definition"
			}
			for _, param := range declaration.Params {
				if len(param.Children) == 0 {
					symbol.Required++
				}
			}
			imports[name][declaration.Text] = symbol
		}
	}
	for name, tree := range trees {
		t.Run(name, func(t *testing.T) {
			checked := check.Check(tree, check.Options{Library: true, Imports: imports})
			unit, err := Compile(checked, name)
			if err != nil {
				t.Fatal(err)
			}
			for _, body := range unit.Bodies {
				if _, err := decodeBytecode(body.Bytecode()); err != nil {
					t.Fatal(err)
				}
			}
		})
	}
}

func TestJoinMapsClosingToken(t *testing.T) {
	for _, ending := range []string{"end", "end wait"} {
		for _, tc := range []struct {
			name, source string
			line, column int
		}{
			{"Handler", "on go\n wait for all\n  send ping to me and wait\n " + ending + " -- close\nend", 4, 2},
			{"local Handler", "on go\n query and wait\nend\non query\n wait for all\n  send ping to me and wait\n " + ending + "\nend", 7, 2},
			{"block Lambda", "on go\n put given\n  wait for all\n   send ping to me and wait\n  " + ending + "\n end given into f\n f() and wait\nend", 5, 3},
		} {
			t.Run(tc.name+"/"+ending, func(t *testing.T) {
				tree, err := syntax.Parse(tc.source)
				if err != nil {
					t.Fatal(err)
				}
				checked := check.Check(tree, check.Options{})
				if len(checked.Diagnostics) != 0 {
					t.Fatal(checked.Diagnostics)
				}
				unit, err := Compile(checked, "test")
				if err != nil {
					t.Fatal(err)
				}
				found := false
				for _, body := range unit.Bodies {
					for _, ins := range body.Code {
						if ins.Name == "join-end" {
							found = true
							if ins.Pos.Line != tc.line || ins.Pos.Column != tc.column {
								t.Fatalf("closing position %+v, want %d:%d", ins.Pos, tc.line, tc.column)
							}
						}
					}
				}
				if !found {
					t.Fatal("no join-end instruction")
				}
			})
		}
	}
}
