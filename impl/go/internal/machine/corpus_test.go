package machine

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/odogono/odgn-talk/impl/go/internal/value"
)

func TestTextModelExecution(t *testing.T) {
	files, _ := filepath.Glob("../../../../corpus/text-model/*/*.talk")
	if len(files) != 11 {
		t.Fatalf("expected eleven execution cases, got %d", len(files))
	}
	figures := regexp.MustCompile(`clause=1 fuel=([0-9]+) alloc=([0-9]+) state=([0-9]+)`)
	for _, file := range files {
		t.Run(filepath.Base(filepath.Dir(file)), func(t *testing.T) {
			source, e := os.ReadFile(file)
			if e != nil {
				t.Fatal(e)
			}
			unit := compile(t, string(source))
			s, e := Initialize(unit)
			if e != nil {
				t.Fatal(e)
			}
			var args []value.Value
			if filepath.Base(file) == "joiner.talk" {
				args = []value.Value{text("e"), text("\u0301")}
			}
			handler := -1
			for index, body := range unit.Bodies {
				if body.Checked.Kind == "handler" {
					handler = index
					break
				}
			}
			if handler < 0 {
				t.Fatal("case has no handler")
			}
			run := Start(s, handler, args, Limits{Fuel: 10000000, Alloc: 16777216, Depth: 200, Pattern: 10000})
			run.Execute(0)
			if run.Status != Completed {
				t.Fatalf("status=%d at=%s:%d error=%s", run.Status, run.At.Name, run.PC, run.Error.Display())
			}
			trace, e := os.ReadFile(filepath.Join(filepath.Dir(file), "case.trace"))
			if e != nil {
				t.Fatal(e)
			}
			for _, line := range strings.Split(string(trace), "\n") {
				if !strings.HasPrefix(line, "vars ") {
					continue
				}
				reader := value.Reader{Text: line[strings.IndexByte(line[5:], ' ')+6:]}
				for j, name := range unit.Variables {
					if !reader.Take(name + "=") {
						t.Fatalf("missing variable %s", name)
					}
					expected, err := reader.Value()
					if err != nil {
						t.Fatal(err)
					}
					if !s.Variables[j].Equal(expected) {
						t.Fatalf("%s=%s want %s", name, s.Variables[j].Display(), expected.Display())
					}
					reader.Take(" ")
				}
				if reader.At != len(reader.Text) {
					t.Fatal("unexamined vars fields")
				}
			}
			match := figures.FindStringSubmatch(string(trace))
			fuel, _ := strconv.ParseInt(match[1], 10, 64)
			alloc, _ := strconv.ParseInt(match[2], 10, 64)
			state, _ := strconv.ParseInt(match[3], 10, 64)
			var size int64
			for _, v := range s.Variables {
				size += Size(v)
			}
			if run.Fuel != fuel || run.Alloc != alloc || size != state {
				t.Fatalf("costs=(%d,%d,%d) want=(%d,%d,%d)", run.Fuel, run.Alloc, size, fuel, alloc, state)
			}
		})
	}
}
