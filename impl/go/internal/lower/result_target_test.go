package lower

import (
	"strings"
	"testing"

	"github.com/odogono/odgn-talk/impl/go/internal/check"
	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
)

// A Result Target is written from `it` after the ask, under the target's
// position (ADR 0112): a move for a local, a store-var for a Script Variable.
func TestAskResultTargetLowering(t *testing.T) {
	for _, tc := range []struct {
		name, source string
		want         []string
	}{
		{"local", "on t item\n ask world to carries item into carried\n return carried\nend t\n", []string{
			"2:2 ask world carries 1", "2:2 store 0 ; it", "2:33 move 0 2 ; it, carried",
		}},
		{"suspending local", "on t key\n ask storage to load key into saved and wait\n return saved\nend t\n", []string{
			"2:2 ask-wait storage load 1", "2:2 store 0 ; it", "2:31 move 0 2 ; it, saved",
		}},
		{"Script Variable", "script variable last\non t\n ask clock to now into last\nend t\n", []string{
			"3:2 ask clock now 0", "3:2 store 0 ; it", "3:24 load 0 ; it", "3:24 store-var 0 ; last",
		}},
		{"no target", "on t\n ask clock to now\n return it\nend t\n", []string{
			"2:2 ask clock now 0", "2:2 store 0 ; it", "3:9 load 0 ; it", "3:2 return",
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tree, err := syntax.Parse(tc.source)
			if err != nil {
				t.Fatal(err)
			}
			checked := check.Check(tree, check.Options{})
			if len(checked.Diagnostics) != 0 {
				t.Fatal(checked.Diagnostics)
			}
			unit, err := Compile(checked, "s")
			if err != nil {
				t.Fatal(err)
			}
			var code []string
			for _, line := range strings.Split(unit.Disassemble(), "\n") {
				if fields := strings.Fields(line); len(fields) > 2 && len(fields[0]) == 4 {
					code = append(code, strings.Join(fields[1:], " "))
				}
			}
			joined := strings.Join(code, "\n")
			if !strings.Contains(joined, strings.Join(tc.want, "\n")) {
				t.Fatalf("want\n%s\nin\n%s", strings.Join(tc.want, "\n"), joined)
			}
		})
	}
}
