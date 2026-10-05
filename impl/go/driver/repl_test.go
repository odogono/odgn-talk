package driver

import (
	"bytes"
	"context"
	"strings"
	"testing"
	"time"

	"github.com/odogono/odgn-talk/impl/go/session"
)

func TestREPLMultilineReadAndForegroundDeadline(t *testing.T) {
	var out bytes.Buffer
	input := ":clock virtual 2026-09-30T10:00:00Z\non echo\nask console to read and wait\nsay it\nend echo\necho and wait\nhello\nfunction twice x\nreturn x * 2\nend twice\ntwice(3)\n:quit\n"
	if err := RunREPL(context.Background(), strings.NewReader(input), &out, REPLOptions{}); err != nil {
		t.Fatal(err)
	}
	if out.String() != "hello\n6\n" {
		t.Fatal(out.String())
	}
	out.Reset()
	input = "on nap\nwait 1 ms\nsay \"awake\"\nend nap\nnap and wait\n2 + 2\n"
	if err := RunREPL(context.Background(), strings.NewReader(input), &out, REPLOptions{}); err != nil {
		t.Fatal(err)
	}
	if out.String() != "awake\n4\n" {
		t.Fatal(out.String())
	}
}
func TestREPLRecordsAndReplays(t *testing.T) {
	var items []session.Item
	var out bytes.Buffer
	env := session.Environment{Now: func() time.Time { return time.Unix(0, 0).UTC() }, Record: func(i session.Item) { items = append(items, i) }}
	if err := RunREPL(context.Background(), strings.NewReader("put 2 into n\nn * 3\n"), &out, REPLOptions{Environment: env}); err != nil {
		t.Fatal(err)
	}
	_, actual, err := ReplayTranscript(items, nil)
	if err != nil {
		t.Fatal(err)
	}
	if WriteTranscript(items) != WriteTranscript(actual) {
		t.Fatal(WriteTranscript(actual))
	}
}
func TestTranscriptValidationAndRoundTrip(t *testing.T) {
	for _, s := range []string{"\n", "| orphan\n", ">\n", "@ tomorrow\n", "~ call\n", "<bad\n", "\xff\n"} {
		if _, err := ParseTranscript(s); err == nil {
			t.Fatalf("accepted %q", s)
		}
	}
	source := "# sample\n> say `a\n| b`\n<\n'\n''quoted\n'> marked\n"
	items, err := ParseTranscript(source)
	if err != nil {
		t.Fatal(err)
	}
	if actual := WriteTranscript(items); actual != source {
		t.Fatal(actual)
	}
}

func TestREPLContinuesKnownHandlerArguments(t *testing.T) {
	var out bytes.Buffer
	input := ":clock virtual 2026-09-30T10:00:00Z\non echo value\nsay value\nend echo\necho 1 +\n2\n"
	if err := RunREPL(context.Background(), strings.NewReader(input), &out, REPLOptions{}); err != nil {
		t.Fatal(err)
	}
	if out.String() != "3\n" {
		t.Fatal(out.String())
	}
}

func TestZeroOverridesReplayAndRestore(t *testing.T) {
	var out bytes.Buffer
	var recorded []session.Item
	env := session.Environment{Record: func(i session.Item) { recorded = append(recorded, i) }}
	input := ":clock virtual 2026-09-30T10:00:00Z\n:limits fuelPerRun 0\n:save\n:limits reset\n1 + 1\n:restore\n1 + 1\n"
	if err := RunREPL(context.Background(), strings.NewReader(input), &out, REPLOptions{Environment: env}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "! limit fault fuel at 1:1") {
		t.Fatal(out.String())
	}
	_, actual, err := ReplayTranscript(recorded, nil)
	if err != nil {
		t.Fatal(err)
	}
	if WriteTranscript(actual) != WriteTranscript(recorded) {
		t.Fatal(WriteTranscript(actual))
	}
}
