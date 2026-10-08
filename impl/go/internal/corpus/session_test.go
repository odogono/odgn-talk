package corpus

import (
	talk "github.com/odogono/odgn-talk/impl/go"
	"github.com/odogono/odgn-talk/impl/go/driver"
	"github.com/odogono/odgn-talk/impl/go/session"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
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
	if count == 0 {
		t.Fatal("found no Session Transcripts")
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

func TestSessionObjectTraceReplaysIndependently(t *testing.T) {
	var items []session.Item
	var trace []string
	reads := 0
	h := session.New(session.Environment{Record: func(i session.Item) { items = append(items, i) }, Trace: func(s string) { trace = append(trace, s) }, Objects: func(c *session.Objects) map[string]*talk.Object {
		k, err := c.DefineKind(talk.ObjectKindDef{Name: "thing", Props: []talk.Prop{{Name: "x", Shape: talk.AnyShape, GetCost: talk.Cost{Fuel: 2}, Get: func(*talk.Object) (talk.Value, error) { reads++; return talk.Int(3), nil }}}})
		if err != nil {
			t.Fatal(err)
		}
		o, err := c.Object(k, "1", struct{}{})
		if err != nil {
			t.Fatal(err)
		}
		return map[string]*talk.Object{"thing": o}
	}})
	h.Input("put thing into held")
	h.Input(":describe min")
	before := strings.Count(strings.Join(trace, "\n"), "> vars")
	rows := strings.Join(h.Input(":describe held"), "\n")
	if reads != 0 || !strings.Contains(rows, `object {kind: "thing", id: "1", disposed: false}`) || !strings.Contains(rows, `property {name: "x"`) || strings.Count(strings.Join(trace, "\n"), "> vars") != before+1 {
		t.Fatal("describe must render passive Object metadata with one snapshot", rows, reads)
	}
	h.Input("put lambda x => x into callback")
	h.Input(":describe callback")
	h.Input(":inspect thing")
	h.Input(":vars")
	dir := t.TempDir()
	for file, source := range map[string]string{"session.transcript": driver.WriteTranscript(items), "case.trace": strings.Join(trace, "\n") + "\n"} {
		if err := os.WriteFile(filepath.Join(dir, file), []byte(source), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := (sessionBackend{}).Run(Case{Name: "native-object-inspect", Dir: dir}, nil); err != nil {
		t.Fatal(err)
	}
}

func TestQueuedSessionFunctionSurvivesExplicitRestore(t *testing.T) {
	var trace []string
	var objects *session.Objects
	held := talk.Nothing
	h := session.New(session.Environment{Now: func() time.Time { return time.Unix(0, 0) }, Trace: func(l string) { trace = append(trace, l) }, ResolveObject: func(string, string) (any, bool) { return nil, true }, Objects: func(c *session.Objects) map[string]*talk.Object {
		objects = c
		k, e := c.DefineKind(talk.ObjectKindDef{Name: "QueuedFunction", Props: []talk.Prop{{Name: "callback", Shape: talk.ValueShape, Get: func(*talk.Object) (talk.Value, error) { return held, nil }, Set: func(_ *talk.Object, v talk.Value) error { held = v; return nil }}}})
		if e != nil {
			t.Fatal(e)
		}
		o, e := c.Object(k, "o", nil)
		if e != nil {
			t.Fatal(e)
		}
		return map[string]*talk.Object{"object": o}
	}})
	h.Input("function plus x\nreturn x + 1\nend plus")
	h.Input("set the callback of object to plus")
	objects.Request(map[string]any{"kind": "call", "fn": held, "args": []talk.Value{talk.Int(4)}})
	h.Input(":save s")
	h.Tick()
	h.Input(":restore s")
	h.Tick()
	h.Input(":vars")
	dir := t.TempDir()
	setup, e := sessionSetup(h, dir)
	if e != nil {
		t.Fatal(e)
	}
	records, e := ParseTrace(strings.Join(trace, "\n") + "\n")
	if e != nil {
		t.Fatal(e)
	}
	actual, e := runReplayPair(Case{Name: "queued function", Dir: dir, Kind: "trace", Setup: setup}, records, nil)
	if e != nil {
		t.Fatal(e)
	}
	if e = Compare("queued function", trace, actual); e != nil {
		t.Fatal(e)
	}
}
