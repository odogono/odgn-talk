package driver

import (
	"bytes"
	"context"
	"os"
	"strings"
	"testing"

	"github.com/odogono/odgn-talk/impl/go/session"
)

func TestREPLFencedText(t *testing.T) {
	for _, test := range []struct{ name, input, want string }{
		{"blank content", "say `\nfirst\n\nsecond\n`\nsay \"\"\"\nraw\n\ntext\n\"\"\"\n", "first\n\nsecond\nraw\n\ntext\n"},
		{"multiline hole", "say `sum ${1 +\n\n2}`\n", "sum 3\n"},
		{"enclosing Entry", "on greet\n say `hello`\n\nend greet\ngreet\n", "hello\n"},
		{"EOF backtick", "say `unfinished", "! unterminated text at 1:5\n"},
		{"EOF raw fence", "say \"\"\"unfinished", "! unterminated text at 1:5\n"},
		{"EOF hole", "say `value ${1 +", "! unterminated interpolation at 1:12\n"},
		{"EOF nested text", "say `value ${`nested", "! unterminated text at 1:14\n"},
	} {
		t.Run(test.name, func(t *testing.T) {
			var out bytes.Buffer
			if err := RunREPL(context.Background(), strings.NewReader(test.input), &out, REPLOptions{}); err != nil {
				t.Fatal(err)
			}
			if out.String() != test.want {
				t.Fatalf("got %q, want %q", out.String(), test.want)
			}
		})
	}
}

func TestREPLSharedFencedTranscript(t *testing.T) {
	source, err := os.ReadFile("../../../corpus/sessions/fenced-text/session.transcript")
	if err != nil {
		t.Fatal(err)
	}
	items, err := ParseTranscript(string(source))
	if err != nil {
		t.Fatal(err)
	}
	var input, expected strings.Builder
	var recorded, wanted []session.Item
	for _, item := range items {
		if item.Kind != "comment" {
			wanted = append(wanted, item)
		}
		switch item.Kind {
		case "input":
			input.WriteString(item.Text + "\n")
		case "output":
			expected.WriteString(item.Text + "\n")
		}
	}
	var out bytes.Buffer
	options := REPLOptions{Environment: session.Environment{Record: func(item session.Item) { recorded = append(recorded, item) }}}
	if err := RunREPL(context.Background(), strings.NewReader(input.String()), &out, options); err != nil {
		t.Fatal(err)
	}
	if out.String() != expected.String() {
		t.Fatalf("got %q, want %q", out.String(), expected.String())
	}
	// New recordings carry setup; the committed legacy Transcript remains readable.
	wanted = append([]session.Item{{Kind: "envelope", Text: `{"objects":{},"type":"setup"}`}}, wanted...)
	if WriteTranscript(recorded) != WriteTranscript(wanted) {
		t.Fatal(WriteTranscript(recorded))
	}
}
