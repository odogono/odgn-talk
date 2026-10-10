package driver

import (
	"bytes"
	"context"
	"os"
	"reflect"
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

func TestSessionChoosesLibraryRecoveryOffer(t *testing.T) {
	library, err := os.ReadFile("../../../corpus/recovery-offers/basic/rows.talk")
	if err != nil {
		t.Fatal(err)
	}
	var trace []string
	var items []session.Item
	h := session.New(session.Environment{Record: func(i session.Item) { items = append(items, i) }, Trace: func(line string) { trace = append(trace, line) }})
	for _, source := range []string{
		":clock virtual 2026-09-30T10:00:00Z",
		":library add rows\n" + strings.TrimRight(string(library), "\n"),
		"use parseRows from rows",
		"function convert row\n return row as number\nend convert",
		"on go\n try\n  put parseRows([\"5\", \"bad\", \"7\"], convert) into rows\n catch e before unwind where offerAvailable(\"useValue\")\n  choose offer useValue(0)\n end try\n say rows\nend go",
	} {
		if out := h.Input(source); len(out) != 0 {
			t.Fatalf("%s: %v", source, out)
		}
	}
	if out := h.Input("go"); !reflect.DeepEqual(out, []string{"[5, 0, 7]"}) {
		t.Fatal(out)
	}
	var replayedTrace []string
	_, replayed, err := ReplayTranscript(items, func(line string) { replayedTrace = append(replayedTrace, line) })
	if err != nil {
		t.Fatal(err)
	}
	if WriteTranscript(replayed) != WriteTranscript(items) || !reflect.DeepEqual(replayedTrace, trace) {
		t.Fatal("Recovery session replay changed Transcript or Trace", replayedTrace, trace)
	}
	chosen, entered := 0, 0
	for _, line := range trace {
		if strings.HasPrefix(line, "offer-chosen ") {
			chosen++
		}
		if strings.HasPrefix(line, "offer-entered ") {
			entered++
		}
	}
	if chosen != 1 || entered != 1 {
		t.Fatalf("choice/entry pairing: %d/%d", chosen, entered)
	}
}

func TestREPLAsksUserPromptsAndReplaysTheirAnswers(t *testing.T) {
	var items []session.Item
	var out, questions bytes.Buffer
	env := session.Environment{Now: func() time.Time { return time.Unix(0, 0).UTC() }, Record: func(i session.Item) { items = append(items, i) }}
	input := strings.Join([]string{
		":grant user user",
		"on size",
		`ask user to choose ["S", "M", "L"], {multiple: true} and wait`,
		"say it",
		"end size",
		"size and wait",
		"4",
		"3, 1",
		`ask user to enter "Name?", {default: "Ann"} and wait`,
		"",
		`tell user to notify "Done", {title: "Backup"}`,
		":quit",
	}, "\n") + "\n"
	if err := RunREPL(context.Background(), strings.NewReader(input), &out, REPLOptions{Environment: env, Questions: &questions}); err != nil {
		t.Fatal(err)
	}
	if out.String() != "[\"S\", \"L\"]\n* Backup: Done\n" {
		t.Fatal(out.String())
	}
	choose := "? Choose any\n  1. S\n  2. M\n  3. L\n  numbers separated by commas, \"none\" for none, or an empty line to cancel\n"
	if questions.String() != choose+choose+"? Name? [Ann]\n  an empty line gives the default\n" {
		t.Fatal(questions.String())
	}
	transcript := WriteTranscript(items)
	if !strings.Contains(transcript, "~ session/r1.c1 [\"S\", \"L\"]\n") || !strings.Contains(transcript, "~ session/r2.c1 \"Ann\"\n") {
		t.Fatal(transcript)
	}
	if _, _, err := ReplayTranscript(items, nil); err != nil {
		t.Fatal(err)
	}
}
