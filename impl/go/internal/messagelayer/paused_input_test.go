package messagelayer

import (
	"fmt"
	"strings"
	"testing"
)

func TestPausedInputsLandAfterTheCrossing(t *testing.T) {
	for _, outcome := range []string{`"result":7`, `"result":"bad"`, `"hostError":"broken"`, `"fail":{"code":"bad","data":{}}`} {
		t.Run(outcome, func(t *testing.T) {
			h := newHost(t)
			h.setup(`[{"name":"read","mode":"immediate","result":"number"}]`, "script variable n=0\non go\n put 9 into n\n ask api to read\n put 8 into n\n return n\nend go", "")
			h.ok("request", `"group":"g","to":{"script":"s"},"message":{"name":"go"}`)
			must(t, h.send("pump", `"group":"g",`+now), "need")
			worker := h.ref
			admission := h.ok("stop", `"group":"g","script":"s","reason":"crossing"`)
			if _, ok := admission["trace"]; ok {
				t.Fatal("premature Trace", show(admission))
			}
			h.ref = worker
			done := must(t, h.result("op-result", outcome), "ok")
			var lines []string
			for _, line := range done["trace"].([]any) {
				lines = append(lines, line.(string))
			}
			trace := strings.Join(lines, "\n")
			call := strings.Index(trace, "call s/r1.c1")
			stop := strings.Index(trace, "> stop s")
			if done["state"] != "stopped" || call < 0 || stop < call || strings.Contains(trace, "call-failed") || strings.Contains(trace, "result=8") {
				t.Fatal(show(done))
			}
		})
	}
}

func TestPausedAnswerDuringStartWaitsForNextPump(t *testing.T) {
	for _, settlement := range []string{"answer", "fail"} {
		t.Run(settlement, func(t *testing.T) {
			h := newHost(t)
			h.setup(`[{"name":"read","mode":"suspending","result":"number"}]`, "on go\n ask api to read and wait\n return it\nend go", "")
			h.ok("request", `"group":"g","to":{"script":"s"},"message":{"name":"go"}`)
			need := must(t, h.send("pump", `"group":"g",`+now), "need")
			worker := h.ref
			payload := `"value":7`
			if settlement == "fail" {
				payload = `"error":{"code":"bad","data":{}}`
			}
			h.ok(settlement, fmt.Sprintf(`"group":"g","call":%q,%s`, need["call"], payload))
			h.ref = worker
			first := must(t, h.result("op-result", `"started":true`), "ok")
			if strings.Contains(show(first["reports"]), `"run end"`) {
				t.Fatal(show(first))
			}
			end := onlyReport(t, h.ok("pump", `"group":"g",`+now))
			want := "completed"
			if settlement == "fail" {
				want = "errored"
			}
			if end["outcome"] != want {
				t.Fatal(show(end))
			}
		})
	}
}
