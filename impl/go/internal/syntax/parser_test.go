package syntax

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEmptyPatternsUseOperandModeAndPreserveSource(t *testing.T) {
	for _, statement := range []string{
		"put <> into result",
		"return <>",
		"return [<>, <>]",
		"return f(<>)",
		"return <(<>)>",
		`let <> be ""`,
		`let [<>, <>] be ["", ""]`,
		`match ""` + "\r\n when <> then\r\n end match",
		`return replace <> in "a" with "+"`,
		`put given <>, <>: true into f`,
		`f <>`,
		`return "a" <> "b"`,
		`return word <> 1`,
		`return word <= 1`,
		`return <> is <>`,
		`return <> is not <>`,
		`next <>`,
	} {
		source := "-- 😀 modal lookahead\r\non go\r\n\t" + statement + " -- tail\r\nend go\r\n"
		tree, err := Parse(source)
		if err != nil {
			t.Fatalf("%s: %v", statement, err)
		}
		if got := tree.Source(); got != source {
			t.Fatalf("source changed: %q, want %q", got, source)
		}
	}
}

func TestEmptyPatternsInHandlerParameters(t *testing.T) {
	for _, parameters := range []string{"<>", "a, <>", "a, <>, b", "<>, queued"} {
		source := "on go " + parameters + "\nend go\n"
		tree, err := Parse(source)
		if err != nil {
			t.Fatalf("%s: %v", parameters, err)
		}
		if tree.Source() != source {
			t.Fatalf("source changed: %q", tree.Source())
		}
	}
}

func TestSharedSyntaxExamples(t *testing.T) {
	root := "../../../.."
	files, err := filepath.Glob(filepath.Join(root, "tools/grammar/sketch/*.talk"))
	if err != nil || len(files) == 0 {
		t.Fatalf("sketch: %v", err)
	}
	for _, dir := range []string{"corpus", "spec/stdlib"} {
		err := filepath.WalkDir(filepath.Join(root, dir), func(path string, entry fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if !entry.IsDir() && strings.HasSuffix(path, ".talk") {
				files = append(files, path)
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	for _, file := range files {
		t.Run(filepath.Base(filepath.Dir(file))+"/"+filepath.Base(file), func(t *testing.T) {
			source, err := os.ReadFile(file)
			if err != nil {
				t.Fatal(err)
			}
			tree, err := Parse(string(source))
			if err != nil {
				t.Fatal(err)
			}
			if tree.Source() != string(source) {
				t.Fatal("tree lost source bytes")
			}
		})
	}
}

func TestSharedFirstSyntaxErrors(t *testing.T) {
	data, err := os.ReadFile("../../../../tools/grammar/broken.talk")
	if err != nil {
		t.Fatal(err)
	}
	for _, section := range strings.Split(string(data), "-- case: ")[1:] {
		lines := strings.Split(section, "\n")
		t.Run(lines[0], func(t *testing.T) {
			want := strings.TrimPrefix(lines[1], "-- expect: ")
			source := strings.Join(lines[2:], "\n")
			_, err := Parse(source)
			if want == "parses" {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			var diagnostic *Error
			if !errors.As(err, &diagnostic) || diagnostic.Error() != want {
				t.Fatalf("got %v, want %s", err, want)
			}
		})
	}
}

func TestExpressionShape(t *testing.T) {
	tree, err := Parse("on test x\nreturn -x ^ 2 ^ 3 + 4 * 5\nend")
	if err != nil {
		t.Fatal(err)
	}
	e := tree.Declarations[0].Body[0].Children[0]
	var shape func(*Node) string
	shape = func(n *Node) string {
		if len(n.Children) == 0 {
			return n.Text
		}
		parts := []string{n.Text}
		for _, child := range n.Children {
			parts = append(parts, shape(child))
		}
		return "(" + strings.Join(parts, " ") + ")"
	}
	if got, want := shape(e), "(+ (^ (- x) (^ 2 3)) (* 4 5))"; got != want {
		t.Fatal(fmt.Sprintf("got %s, want %s", got, want))
	}
}

func TestNestedBinarySizeAndBuildExpressions(t *testing.T) {
	for _, source := range []string{"on t n\nlet <<data: (^n * 2) bytes>> be <<>>\nend", "on t x\nreturn << (x as uint16) >>\nend"} {
		if _, err := Parse(source); err != nil {
			t.Fatal(err)
		}
	}
	_, err := Parse("on t\nput 1 m2 into x\nend")
	var d *Error
	if !errors.As(err, &d) || d.Pos != (Position{2, 7}) {
		t.Fatal(err)
	}
}

func TestRejectedFunctionGuardAndReciprocal(t *testing.T) {
	for _, tc := range []struct {
		source, code string
		line, col    int
	}{
		{"function f x where true\nreturn x\nend", "unexpected token", 1, 14},
		{"on t\nreturn 1 1/\nend", "bad unit", 2, 10},
		{"on t\nreturn 1 as 1/\nend", "bad unit", 2, 13},
	} {
		_, err := Parse(tc.source)
		e, ok := err.(*Error)
		if !ok || e.Code != tc.code || e.Pos != (Position{Line: tc.line, Column: tc.col}) {
			t.Errorf("%s: %v", tc.source, err)
		}
	}
}
