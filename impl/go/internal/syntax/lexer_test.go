package syntax

import (
	"errors"
	"strings"
	"testing"
)

func TestLexicalSourcePreservation(t *testing.T) {
	source := "\ufeff-- heading\r\non Put\tword_2\r  put \"e\u0301\\n\" into x -- tail\nend Put"
	l, err := NewLexer(source)
	if err != nil {
		t.Fatal(err)
	}
	var restored strings.Builder
	var text Token
	for {
		token, err := l.Next(Operand)
		if err != nil {
			t.Fatal(err)
		}
		restored.WriteString(token.Leading)
		restored.WriteString(token.Raw)
		if token.Kind == Text {
			text = token
		}
		if token.Kind == EOF {
			break
		}
	}
	if restored.String() != source {
		t.Fatalf("source changed: %q", restored.String())
	}
	if text.Value != "é\\n" || text.Pos != (Position{3, 7}) {
		t.Fatalf("text: %+v", text)
	}
}

func TestLexicalErrors(t *testing.T) {
	for _, tc := range []struct {
		source, code string
		pos          Position
	}{
		{"naïve", "bad character", Position{1, 3}},
		{"\"😀e\u0301\" @", "bad character", Position{1, 7}},
		{"\t\"no\r\n", "unterminated text", Position{1, 2}},
		{"x'suffix", "bad character", Position{1, 2}},
		{"\ufeffx\ufeff", "bad character", Position{1, 3}},
	} {
		t.Run(tc.source, func(t *testing.T) {
			l, err := NewLexer(tc.source)
			if err != nil {
				t.Fatal(err)
			}
			for err == nil {
				_, err = l.Next(Operator)
			}
			var diagnostic *Error
			if !errors.As(err, &diagnostic) || diagnostic.Code != tc.code || diagnostic.Pos != tc.pos {
				t.Fatalf("got %v, want %s at %v", err, tc.code, tc.pos)
			}
		})
	}
	if _, err := NewLexer(string([]byte{0xff})); err == nil {
		t.Fatal("invalid UTF-8 accepted")
	}
}

func TestModalPunctuators(t *testing.T) {
	for _, tc := range []struct {
		source string
		mode   Mode
		want   []string
	}{
		{"<=>><<...", Operator, []string{"<=", ">>", "<<", "..."}},
		{"<>>", Pattern, []string{"<", ">", ">"}},
		{"0x1F 007.50 1..2", Operand, []string{"0x1F", "007.50", "1", "..", "2"}},
		{"x's size", Operator, []string{"x", "'s", "size"}},
	} {
		l, _ := NewLexer(tc.source)
		for _, want := range tc.want {
			token, err := l.Next(tc.mode)
			if err != nil || token.Raw != want {
				t.Fatalf("%q: got %+v, %v, want %q", tc.source, token, err, want)
			}
		}
	}
}

func TestUnits(t *testing.T) {
	for _, tc := range []struct {
		source string
		mode   Mode
		kind   Kind
		raw    string
		code   string
	}{
		{"mi/hr", AfterNumber, Unit, "mi/hr", ""},
		{"m*m", AfterNumber, Unit, "m*m", ""},
		{"1/s", AfterNumber, Unit, "1/s", ""},
		{"mod", AfterNumber, Word, "mod", ""},
		{"kg", AfterAs, Word, "kg", ""},
		{"m/s^2", AfterAs, Unit, "m/s^2", ""},
		{"m*ft", AfterNumber, Unit, "", "bad unit"},
		{"m*width", AfterNumber, Unit, "", "bad unit"},
		{"s^-1", AfterNumber, Unit, "", "bad unit"},
		{"m/s/kg", AfterNumber, Unit, "", "bad unit"},
		{"USD/month", AfterNumber, Unit, "", "bad unit"},
	} {
		l, _ := NewLexer(tc.source)
		token, err := l.Next(tc.mode)
		if tc.code != "" {
			var diagnostic *Error
			if !errors.As(err, &diagnostic) || diagnostic.Code != tc.code {
				t.Fatalf("%s: got %v", tc.source, err)
			}
			continue
		}
		if err != nil || token.Kind != tc.kind || token.Raw != tc.raw {
			t.Fatalf("%s: %+v, %v", tc.source, token, err)
		}
	}
}
