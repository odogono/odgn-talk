package apicheck

import (
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestEmbeddingAPI(t *testing.T) {
	fset := token.NewFileSet()
	spec, err := parser.ParseFile(fset, "../../../../spec/embedding/talk.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir("../..")
	if err != nil {
		t.Fatal(err)
	}
	want := declarations(spec)
	got := map[string]string{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".go") || strings.HasSuffix(entry.Name(), "_test.go") {
			continue
		}
		file, err := parser.ParseFile(fset, filepath.Join("../..", entry.Name()), nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		for name, signature := range declarations(file) {
			got[name] = signature
		}
	}
	missing, failures := compare(want, got)
	for _, failure := range failures {
		t.Error(failure)
	}
	for _, name := range []string{"Add", "Core.StoreCapability", "StoreImpl"} {
		if slices.Contains(missing, name) {
			t.Errorf("Store API remains unimplemented: %s", name)
		}
	}
	// Until #141, unimplemented declarations are reported rather than stubbed.
	t.Logf("%d declared API names remain unimplemented: %s", len(missing), strings.Join(missing, ", "))
}

func TestAPIComparison(t *testing.T) {
	parse := func(source string) map[string]string {
		file, err := parser.ParseFile(token.NewFileSet(), "api.go", "package northtalk\n"+source, 0)
		if err != nil {
			t.Fatal(err)
		}
		return declarations(file)
	}
	want := parse(`import "time"
type Value struct{}
type Pair struct { Key string; Val Value }
func Text(s string) (Value, error)
func (v Value) AsText() (string, bool)
func Instant(seconds, nanos int) time.Time`)
	for _, test := range []struct {
		source  string
		errors  int
		missing int
	}{
		{`import clock "time"
type Value struct { text string }
type Pair struct { Key string; Val Value }
func Text(input string) (value Value, err error)
func (value Value) AsText() (text string, ok bool)
func Instant(a int, b int) clock.Time`, 0, 0},
		{`func Text(s string) Value`, 1, 4},
		{`func Extra()`, 1, 5},
		{`func (v *Value) AsText() (string, bool)`, 1, 4},
		{`type Value struct { Exposed string }`, 1, 4},
		{`type Value struct { hidden }; type hidden struct { Extra string }`, 1, 4},
		{`type Pair struct { Key []byte; Val Value }`, 1, 4},
		{`type Value = string`, 1, 4},
	} {
		missing, failures := compare(want, parse(test.source))
		if len(failures) != test.errors || len(missing) != test.missing {
			t.Fatalf("%s: missing %v; failures %v", test.source, missing, failures)
		}
	}
}
