package lower

import (
	"github.com/odogono/odgn-talk/impl/go/internal/check"
	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
	"slices"
	"testing"
)

func compileSource(t *testing.T, source string) *Unit {
	t.Helper()
	tree, err := syntax.Parse(source)
	if err != nil {
		t.Fatal(err)
	}
	unit, err := Compile(check.Check(tree, check.Options{}), "s")
	if err != nil {
		t.Fatal(err)
	}
	return unit
}

func TestNestedInlineFinally(t *testing.T) {
	unit := compileSource(t, "on t c\ntry\nif c then return 1\nsay 2\nfinally\ntry\nsay 3\nfinally\nsay 4\nend\nend\nend")
	body := unit.Bodies[1]
	for _, condition := range []string{"false", "true"} {
		locals := make([]string, len(body.Checked.Locals))
		locals[1] = condition
		var stack, said []string
		pop := func() string { value := stack[len(stack)-1]; stack = stack[:len(stack)-1]; return value }
		returned := false
		for pc, steps := 0, 0; pc < len(body.Code) && steps < 200; pc, steps = pc+1, steps+1 {
			instruction := body.Code[pc]
			switch instruction.Name {
			case "const":
				stack = append(stack, unit.Constants[instruction.args[0].index])
			case "load":
				stack = append(stack, locals[instruction.args[0].index])
			case "store":
				locals[instruction.args[0].index] = pop()
			case "branch-false":
				if pop() == "false" {
					pc = instruction.args[0].target.pc - 1
				}
			case "jump":
				pc = instruction.args[0].target.pc - 1
			case "tell":
				said = append(said, pop())
			case "return":
				pop()
				returned = true
			default:
				t.Fatalf("unexpected reachable %s", instruction.Name)
			}
			if returned {
				break
			}
		}
		expected := []string{"2", "3", "4"}
		if condition == "true" {
			expected = []string{"3", "4"}
		}
		if !returned || !slices.Equal(said, expected) {
			t.Fatalf("%s: %v", condition, said)
		}
	}
	for pc, instruction := range body.Code {
		if instruction.Name == "tell" && instruction.Pos.Line == 4 {
			covered := false
			for _, region := range body.Unwind {
				if region.kind == "finally" && region.first <= pc && pc <= region.last {
					covered = true
				}
			}
			if !covered {
				t.Fatal("normal body lost finally unwind coverage")
			}
		}
	}
}

func TestEmptyElseAndErrorShorthand(t *testing.T) {
	unit := compileSource(t, "on t\nif true then\nsay 1\nelse\nend\nend\non error \"oops\"\nend")
	jumped, codeKey := false, false
	for _, instruction := range unit.Bodies[1].Code {
		if instruction.Name == "jump" && instruction.Pos.Line == 2 {
			jumped = true
		}
	}
	for _, instruction := range unit.Bodies[2].Code {
		if instruction.Name == "map-get" && instruction.args[0].text == `"code"` {
			codeKey = true
		}
	}
	if !jumped || !codeKey {
		t.Fatal(unit.Disassemble())
	}
}

func TestPinsReadCommittedLocals(t *testing.T) {
	unit := compileSource(t, "on t n, packet\nlet <<n: uint8, body: ^n bytes>> be packet\nlet [n, ^n] be []\nend")
	count := 0
	for _, instruction := range unit.Bodies[1].Code {
		if instruction.Name == "load" && instruction.args[0].index == 1 && instruction.Pos.Line >= 2 {
			count++
		}
	}
	if count != 2 {
		t.Fatal(unit.Disassemble())
	}
}
func TestLoweredSuspensionMetadata(t *testing.T) {
	unit := compileSource(t, "on t\nput given\nsend foo to me and wait\nend into f\nend")
	if !unit.Bodies[2].Checked.MaySuspend {
		t.Fatal("lambda suspension missing from body metadata")
	}
}
