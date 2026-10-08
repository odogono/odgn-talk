package corpus

import (
	"github.com/odogono/odgn-talk/impl/go/driver"
	"github.com/odogono/odgn-talk/impl/go/session"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSessionTranscriptParity(t *testing.T) {
	cases, err := Discover("../../../../corpus", nil)
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile("../../corpus-passing.txt")
	if err != nil {
		t.Fatal(err)
	}
	listed := map[string]bool{}
	for _, line := range strings.Split(string(b), "\n") {
		listed[line] = true
	}
	runner := Runner{Root: "../../../../corpus", Backends: ExecutionBackends()}
	count := 0
	for _, c := range cases {
		if c.Kind != "transcript" {
			continue
		}
		count++
		if !listed[c.Name] {
			t.Errorf("required Session Transcript not listed: %s", c.Name)
		}
		t.Run(c.Name, func(t *testing.T) {
			if why := runner.support(c); why != "" {
				t.Fatal(why)
			}
			if _, err := runner.execute(c); err != nil {
				t.Fatal(err)
			}
		})
	}
	if count != 12 {
		t.Fatalf("expected 12 Session Transcripts, got %d", count)
	}
}

func TestSessionFireAndForgetSaveTraceReplaysIndependently(t *testing.T) {
	var items []session.Item
	var trace []string
	h := session.New(session.Environment{Record: func(i session.Item) { items = append(items, i) }, Trace: func(s string) { trace = append(trace, s) }})
	for _, source := range []string{":mock log.write fire-and-forget", ":clock virtual 2026-09-30T10:00:00Z", "tell log to write 1", ":save", ":restore"} {
		h.Input(source)
	}
	h.Inspect()
	dir := t.TempDir()
	for file, source := range map[string]string{"session.transcript": driver.WriteTranscript(items), "case.trace": strings.Join(trace, "\n") + "\n"} {
		if err := os.WriteFile(filepath.Join(dir, file), []byte(source), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := (sessionBackend{}).Run(Case{Name: "native-fire-save", Dir: dir}, nil); err != nil {
		t.Fatal(err)
	}
}

func TestSessionStoreTraceReplaysIndependently(t *testing.T) {
	var items []session.Item
	var trace []string
	h := session.New(session.Environment{Record: func(i session.Item) { items = append(items, i) }, Trace: func(s string) { trace = append(trace, s) }})
	for _, source := range []string{":grant st store", ":grant alias store default", ":clock virtual 2026-10-07T10:00:00Z", ":store load\n{\"best\":9}", "ask st to increment \"plays\", 3", "on peek\nask alias to get \"best\"\nsay it\nend peek", "peek", ":save", "ask st to set \"best\", 10", ":restore", "peek"} {
		h.Input(source)
	}
	h.Inspect()
	dir := t.TempDir()
	for file, source := range map[string]string{"session.transcript": driver.WriteTranscript(items), "case.trace": strings.Join(trace, "\n") + "\n"} {
		if err := os.WriteFile(filepath.Join(dir, file), []byte(source), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := (sessionBackend{}).Run(Case{Name: "native-store-save", Dir: dir}, nil); err != nil {
		t.Fatal(err)
	}
}
