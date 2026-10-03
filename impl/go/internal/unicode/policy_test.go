package unicode

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"strconv"
	"strings"
	"testing"
)

// Imported aliases and dot imports cannot bypass the observable Unicode policy.
func policyViolations(source string) ([]string, error) {
	file, err := parser.ParseFile(token.NewFileSet(), "unicode.go", source, 0)
	if err != nil {
		return nil, err
	}
	var failures []string
	stringAliases := map[string]bool{}
	for _, imp := range file.Imports {
		path, err := strconv.Unquote(imp.Path.Value)
		if err != nil {
			return nil, err
		}
		if path == "unicode" || path == "golang.org/x/text" || strings.HasPrefix(path, "golang.org/x/text/") {
			failures = append(failures, "forbidden Unicode import: "+path)
		}
		if path == "strings" {
			name := "strings"
			if imp.Name != nil {
				name = imp.Name.Name
			}
			if name == "." {
				failures = append(failures, "dot import of strings")
			}
			stringAliases[name] = true
		}
	}
	ast.Inspect(file, func(node ast.Node) bool {
		selector, ok := node.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		name, ok := selector.X.(*ast.Ident)
		if ok && stringAliases[name.Name] && (strings.HasPrefix(selector.Sel.Name, "To") || selector.Sel.Name == "EqualFold" || strings.HasPrefix(selector.Sel.Name, "Title")) {
			failures = append(failures, "platform case function: "+selector.Sel.Name)
		}
		return true
	})
	return failures, nil
}

func TestUnicodeImportPolicy(t *testing.T) {
	files, err := parser.ParseDir(token.NewFileSet(), ".", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, pkg := range files {
		for name := range pkg.Files {
			// Re-read through the same helper used by the enforcement fixtures.
			data, err := os.ReadFile(name)
			if err != nil {
				t.Fatal(err)
			}
			failures, err := policyViolations(string(data))
			if err != nil {
				t.Fatal(err)
			}
			for _, failure := range failures {
				t.Errorf("%s: %s", name, failure)
			}
		}
	}
}

func TestUnicodePolicyCannotBeBypassedByAliases(t *testing.T) {
	for _, source := range []string{
		`package p; import u "unicode"; var x = u.IsSpace`,
		`package p; import s "strings"; var x = s.ToLower`,
		`package p; import s "strings"; var x = s.EqualFold`,
		`package p; import . "strings"; var x = ToUpper`,
		`package p; import "golang.org/x/text/unicode/norm"; var x = norm.NFC`,
	} {
		failures, err := policyViolations(source)
		if err != nil || len(failures) == 0 {
			t.Fatalf("policy accepted %s: %v", source, err)
		}
	}
	failures, err := policyViolations(`package p; import "unicode/utf8"; var x = utf8.ValidString`)
	if err != nil || len(failures) != 0 {
		t.Fatalf("UTF-8 decoder refused: %v, %v", failures, err)
	}
}
