package syntax

import (
	"errors"
	"strings"
	"testing"
)

func TestNestingRefusesEveryRecursiveRegion(t *testing.T) {
	deep := 100_000
	cases := map[string]string{
		"parentheses":      strings.Repeat("(", deep) + "1" + strings.Repeat(")", deep),
		"lists":            strings.Repeat("[", deep) + "1" + strings.Repeat("]", deep),
		"maps":             strings.Repeat("{a:", deep) + "1" + strings.Repeat("}", deep),
		"calls":            strings.Repeat("f(", deep) + "1" + strings.Repeat(")", deep),
		"minus":            strings.Repeat("- ", deep) + "1",
		"not":              strings.Repeat("not ", deep) + "true",
		"powers":           strings.Repeat("1 ^ ", deep) + "1",
		"sums":             strings.Repeat("1 + ", deep) + "1",
		"properties":       strings.Repeat("the a of ", deep) + "1",
		"postfix":          "1" + strings.Repeat("'s a", deep),
		"lambdas":          strings.Repeat("given x: ", deep) + "1",
		"interpolation":    "`" + strings.Repeat("${`", 1000) + "x" + strings.Repeat("`}", 1000) + "`",
		"pattern counts":   "<" + strings.Repeat("1 ", deep) + "digit>",
		"pattern captures": "<" + strings.Repeat("x:", deep) + "digit>",
		"pattern groups":   strings.Repeat("<", deep) + "digit" + strings.Repeat(">", deep),
	}
	for name, expression := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := Parse("on go\nreturn " + expression + "\nend go\n")
			assertNestingError(t, err)
			_, _, err = ParseEntry(expression, nil)
			assertNestingError(t, err)
		})
	}
	statements := map[string]string{
		"if":       strings.Repeat("if true then\n", 10_000) + strings.Repeat("end if\n", 10_000),
		"repeat":   strings.Repeat("repeat forever\n", 10_000) + strings.Repeat("end repeat\n", 10_000),
		"bindings": "let " + strings.Repeat("[", deep) + "x" + strings.Repeat("]", deep) + " be []\n",
	}
	for name, statement := range statements {
		t.Run(name, func(t *testing.T) {
			_, err := Parse("on go\n" + statement + "end go\n")
			assertNestingError(t, err)
			_, _, err = ParseEntry(statement, nil)
			assertNestingError(t, err)
		})
	}
}

func assertNestingError(t *testing.T, err error) {
	t.Helper()
	var got *Error
	if !errors.As(err, &got) || got.Code != "source nesting too deep" || got.Incomplete || got.Pos.Line < 1 || got.Pos.Column < 1 {
		t.Fatalf("want positioned, complete nesting refusal, got %v", err)
	}
}

func TestNestingBoundaryAndWideTrees(t *testing.T) {
	// A declaration and return add two nodes above the expression.
	for _, depth := range []int{MaxNesting - 3, MaxNesting - 2} {
		source := "on go\nreturn " + strings.Repeat("(", depth) + "1" + strings.Repeat(")", depth) + "\nend go\n"
		tree, err := Parse(source)
		if depth == MaxNesting-3 {
			if err != nil || tree.Source() != source {
				t.Fatalf("valid nesting refused: %v", err)
			}
		} else {
			assertNestingError(t, err)
		}
	}
	source := strings.Repeat("on go\nreturn 1\nend go\n", 10_000)
	if _, err := Parse(source); err != nil {
		t.Fatal(err)
	}
	// Sibling expressions and interpolation holes do not consume each other's budget.
	for _, expression := range []string{"[" + strings.Repeat("[1],", 1000) + "[1]]", "`" + strings.Repeat("${1}", 10) + "`"} {
		if _, _, err := ParseEntry(expression, nil); err != nil {
			t.Fatal(err)
		}
	}
}
