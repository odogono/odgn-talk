package fuzz

import (
	"bytes"
	"encoding/json"
	"slices"
	"strings"
	"testing"

	talk "github.com/odogono/odgn-talk/impl/go"
)

const suspendCase = `{
  "version": 1, "generator": "scheduler-1", "seed": "1", "commit": "test",
  "profile": ["suspend"], "choices": {"inputs": [], "scripts": []},
  "setup": {
    "operations": [{"capability": "remote", "name": "get", "mode": "suspending", "args": [], "result": "number", "maxPending": 1000, "cost": {"fuel": 1}}],
    "scripts": [{"name": "a", "source": "a.talk", "text": "script variable count = 0\non fetch\nask remote to get and wait\nput it into count\nend fetch", "grants": {"remote": {"ops": "all"}}}]
  },
  "inputs": [
    {"kind": "input", "line": "> load a"},
    {"kind": "answer", "nth": 0, "value": "1"},
    {"kind": "input", "line": "> deliver to=a message=fetch"},
    {"kind": "input", "line": "> deliver to=a message=fetch"},
    {"kind": "input", "line": "> pump clock=2026-10-02T00:00:00Z"},
    {"kind": "input", "line": "> save"},
    {"kind": "restore", "nth": 0},
    {"kind": "settle", "nth": 1, "how": "adopt"},
    {"kind": "answer", "nth": 0, "value": "7"},
    {"kind": "cancel-run", "nth": 0, "script": "a"},
    {"kind": "input", "line": "> pump clock=2026-10-02T00:00:01Z"}
  ]
}`

func serve(t *testing.T, requests ...string) []map[string]any {
	t.Helper()
	var out bytes.Buffer
	if err := Serve(strings.NewReader(strings.Join(requests, "\n")+"\n"), &out); err != nil {
		t.Fatal(err)
	}
	var responses []map[string]any
	for _, line := range strings.Split(strings.TrimSuffix(out.String(), "\n"), "\n") {
		var response map[string]any
		if err := json.Unmarshal([]byte(line), &response); err != nil {
			t.Fatalf("%v: %s", err, line)
		}
		responses = append(responses, response)
	}
	if len(responses) != len(requests) {
		t.Fatalf("got %d responses to %d requests", len(responses), len(requests))
	}
	return responses
}

func TestCapabilitiesReportTheCoreVersions(t *testing.T) {
	got := serve(t, `{"type":"capabilities"}`, `{"type":"other"}`, `not json`)
	versions := talk.CoreVersions()
	if got[0]["version"] != 1.0 || got[0]["languageVersion"] != versions.Language || got[0]["costModel"] != versions.CostModel {
		t.Fatalf("capabilities = %v", got[0])
	}
	if len(got[0]["features"].([]any)) != len(Features) {
		t.Fatalf("features = %v", got[0]["features"])
	}
	if got[1]["error"] != "Unknown worker request" || got[2]["error"] == nil {
		t.Fatalf("errors = %v, %v", got[1], got[2])
	}
}

func TestSymbolicInputsResolveAgainstThisCoresTrace(t *testing.T) {
	c, err := ReadCase(json.RawMessage(suspendCase))
	if err != nil {
		t.Fatal(err)
	}
	result := Run(c)
	if len(result.Findings) > 0 {
		t.Fatal(result.Findings)
	}
	e := result.Execution
	inputs := []string{}
	for _, line := range e.Trace {
		if strings.HasPrefix(line, "> ") && !strings.HasPrefix(line, "> load ") && !strings.HasPrefix(line, "> restore ") {
			inputs = append(inputs, line)
		}
	}
	// The first answer has no pending call; the settle picks the second
	// restored call; the answer then picks the first adopted one.
	want := []string{
		"> deliver d1 to=a message=fetch",
		"> deliver d2 to=a message=fetch",
		"> pump clock=2026-10-02T00:00:00Z",
		"> save s1",
		"> settle a/r2.c1 how=adopt",
		"> answer a/r2.c1 value=7",
		"> cancel-run a/r1",
		"> pump clock=2026-10-02T00:00:01Z",
	}
	if !slices.Equal(inputs, want) {
		t.Fatalf("inputs =\n%s", strings.Join(inputs, "\n"))
	}
	if e.Counts.Noops != 1 || e.Counts.Applied != 10 || e.Counts.Actions["pump"] != 2 || e.Counts.Records[">restore"] != 1 {
		t.Fatalf("counts = %+v", e.Counts)
	}
	if len(e.Fingerprints) != e.Counts.Applied || e.Fingerprints[0].Before == e.Fingerprints[0].After {
		t.Fatalf("fingerprints = %+v", e.Fingerprints)
	}
}

func TestMissingInlineSourceIsAGeneratorFinding(t *testing.T) {
	c, err := ReadCase(json.RawMessage(strings.Replace(suspendCase, `"text": "script variable`, `"other": "script variable`, 1)))
	if err != nil {
		t.Fatal(err)
	}
	result := Run(c)
	if result.Execution != nil || len(result.Findings) != 1 || result.Findings[0].Classification != "generator" || result.Findings[0].Signature.Oracle != "harness-validity" {
		t.Fatalf("result = %+v", result)
	}
}

func TestMalformedCasesAreRefused(t *testing.T) {
	for _, raw := range []string{`{}`, `{"version": 2}`, strings.Replace(suspendCase, `"seed": "1"`, `"seed": 1`, 1)} {
		if _, err := ReadCase(json.RawMessage(raw)); err == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
}
