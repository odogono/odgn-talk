package lower

import (
	"fmt"
	"github.com/odogono/odgn-talk/impl/go/internal/check"
	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// #251 supplies the Abstract Machine. This test drives the load-error
// boundary with the new case's actual lowered numeric instructions, so the
// diagnostic position comes from the source map, not an AST guess.
func TestInitialiserFailureCorpus(t *testing.T) {
	root := "../../../../corpus/load-diagnostics/initialiser-failed"
	source, err := os.ReadFile(filepath.Join(root, "bad.talk"))
	if err != nil {
		t.Fatal(err)
	}
	tree, err := syntax.Parse(string(source))
	if err != nil {
		t.Fatal(err)
	}
	checked := check.Check(tree, check.Options{})
	unit, err := Compile(checked, "bad")
	if err != nil {
		t.Fatal(err)
	}
	var stack []*big.Rat
	failed := false
	for _, instruction := range unit.Bodies[0].Code {
		switch instruction.Name {
		case "const":
			value, ok := new(big.Rat).SetString(unit.Constants[instruction.args[0].index])
			if !ok {
				t.Fatalf("unexpected constant: %v", instruction)
			}
			stack = append(stack, value)
		case "divide":
			if stack[len(stack)-1].Sign() == 0 {
				checked.InitialiserFailed(instruction.Pos)
				failed = true
			} else {
				t.Fatal("case must divide by zero")
			}
		default:
			t.Fatalf("unexpected instruction before failure: %s", instruction.Name)
		}
		if failed {
			break
		}
	}
	if !failed || len(checked.Diagnostics) != 1 {
		t.Fatal(checked.Diagnostics)
	}
	d := checked.Diagnostics[0]
	record := fmt.Sprintf("diag bad code=%q pos=%d:%d", d.Code, d.Pos.Line, d.Pos.Column)
	trace, err := os.ReadFile(filepath.Join(root, "case.trace"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(trace), "\n"+record+"\n") {
		t.Fatalf("unexpected load error %s", record)
	}
}
