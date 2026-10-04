package syntax

import (
	"errors"
	"strings"
	"testing"
)

func TestFencedTextPreservesSource(t *testing.T) {
	for name, expression := range map[string]string{
		"inline interpolation":    "`hello ${name}`",
		"ordinary JSON braces":    "`{\"answer\": ${1 + 2}}`",
		"nested interpolation":    "`outer ${`inner ${3}`}`",
		"nested maps":             "`value ${the value of {value: 3}}`",
		"multiline hole":          "`sum ${1 +\n2}`",
		"comment in hole":         "`sum ${1 + -- ordinary code\n2}`",
		"raw template":            `"""${name} \n "two" end"""`,
		"longer raw fence":        `""""a """ b""""`,
		"margin":                  "`\r\n\t hello ${name}\r\n\t `",
		"nested literal margin":   "`outer ${\"\"\"\n  inner\n  \"\"\"}`",
		"inline physical newline": "`first\n  second`",
		"literal map keys":        "{`key`: 1, \"\"\"other\"\"\": 2}",
		"literal pattern atoms":   "<`a`, \"\"\"b\"\"\">",
	} {
		t.Run(name, func(t *testing.T) {
			source := "on go name\n return " + expression + "\nend go"
			tree, err := Parse(source)
			if err != nil {
				t.Fatal(err)
			}
			if got := tree.Source(); got != source {
				t.Fatalf("source changed: got %q, want %q", got, source)
			}
		})
	}
}

func TestFencedRawTextValues(t *testing.T) {
	for _, tc := range []struct{ name, source, want string }{
		{"literal placeholders", `"""${name} \n end"""`, "${name} \\n end"},
		{"short quote runs", `""""a """ b""""`, `a """ b`},
		{"margin and trailing spaces", "\"\"\"\n  first  \n\n    second\n  \n  \"\"\"", "first  \n\n  second\n"},
		{"exact tab margin", "\"\"\"\n\t first\n\t\n\t second\n\t \"\"\"", "first\n\nsecond"},
		{"inline whitespace", "\"\"\" first\n  second \"\"\"", " first\n  second "},
		{"NFC", "\"\"\"e\u0301\"\"\"", "é"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			lexer, err := NewLexer(tc.source)
			if err != nil {
				t.Fatal(err)
			}
			token, err := lexer.Next(Operand)
			if err != nil {
				t.Fatal(err)
			}
			if token.Value != tc.want || token.Raw != tc.source {
				t.Fatalf("got value %q, raw %q; want value %q, raw %q", token.Value, token.Raw, tc.want, tc.source)
			}
			end, err := lexer.Next(Operator)
			if err != nil || end.Kind != EOF {
				t.Fatalf("literal did not consume its closing fence: %+v, %v", end, err)
			}
		})
	}
}

func TestFencedRawTextNormalizesLineEndings(t *testing.T) {
	for _, newline := range []string{"\n", "\r\n", "\r"} {
		source := strings.Join([]string{`"""`, "  first", "  second", `  """`}, newline)
		lexer, err := NewLexer(source)
		if err != nil {
			t.Fatal(err)
		}
		token, err := lexer.Next(Operand)
		if err != nil || token.Value != "first\nsecond" {
			t.Errorf("newline %q: got value %q, error %v", newline, token.Value, err)
		}
	}
}

func TestFencedTextAcceptsJavaScriptEscapes(t *testing.T) {
	for _, literal := range []string{
		"`\\x41\\u0042\\u{1F600}`",
		"`\\uD83D\\uDE00`",
		"`\\q \\${name} \\``",
		"`\\0\\b\\f\\n\\r\\t\\v`",
		"`\n  first\\\n  second\n  `",
	} {
		if _, err := Parse("constant value = " + literal); err != nil {
			t.Errorf("%q: %v", literal, err)
		}
	}
}

func TestFencedTextDiagnosticPositions(t *testing.T) {
	for _, tc := range []struct {
		name, expression string
		pos              Position
	}{
		{"unterminated backtick", "`hello", Position{2, 9}},
		{"unterminated raw", `"""hello`, Position{2, 9}},
		{"unterminated hole", "`value ${1 +", Position{2, 16}},
		{"innermost unfinished literal", "`outer ${`inner", Position{2, 18}},
		{"invalid hex", "`a\\xGG`", Position{2, 11}},
		{"out of range scalar", "`a\\u{110000}`", Position{2, 11}},
		{"unpaired high surrogate", "`a\\uD800`", Position{2, 11}},
		{"unpaired low surrogate", "`a\\uDC00`", Position{2, 11}},
		{"legacy octal", "`a\\01`", Position{2, 11}},
		{"legacy decimal escape", "`a\\8`", Position{2, 11}},
		{"margin mismatch", "`\n \ttext\n  `", Position{3, 2}},
		{"non-whitespace backtick closing margin", "`\n  first\n \tbad`", Position{4, 3}},
		{"non-whitespace raw closing margin", "\"\"\"\n  first\n \tbad\"\"\"", Position{4, 3}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Parse("on go\n return " + tc.expression)
			var diagnostic *Error
			if !errors.As(err, &diagnostic) || diagnostic.Pos != tc.pos || diagnostic.Code == "bad character" {
				t.Fatalf("got %v; want syntax error at %v", err, tc.pos)
			}
		})
	}
}

func TestFencedTextReportsEarlierHoleSyntaxError(t *testing.T) {
	for _, tail := range []string{"\\xGG", `${"""x""""}`} {
		_, err := Parse("on go\n return `${1 + return}" + tail + "`\nend go")
		var diagnostic *Error
		if !errors.As(err, &diagnostic) || diagnostic.Code != "unexpected token" || diagnostic.Pos != (Position{2, 16}) {
			t.Errorf("tail %q: got %v, want unexpected token at 2:16", tail, err)
		}
	}
}
