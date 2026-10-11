package messagelayer

import (
	"fmt"
	"strings"
	"testing"
)

func releaseHost(t *testing.T, source string) *host {
	t.Helper()
	h := newHost(t)
	h.ok("define-capability", `"name":"api","release":true,"ops":[{"name":"touch","mode":"immediate","result":"nothing"}]`)
	grant := h.ok("grant", `"capability":"api","ops":"all"`)["grant"]
	h.ok("new-group", `"group":"g","name":"g","trace":true`)
	h.ok("load", fmt.Sprintf(`"group":"g","name":"s","source":%q,"grants":{"z":%v,"api":%v}`, source, grant, grant))
	h.ok("pump", `"group":"g",`+now)
	return h
}

func expectRelease(t *testing.T, reply map[string]any, grant, reason string) {
	t.Helper()
	need := must(t, reply, "need")
	if show(need) != show(map[string]any{"m": "release", "script": "s", "grant": grant, "reason": reason, "now": "2026-10-09T12:00:00Z"}) {
		t.Fatal(show(need))
	}
}

func TestReleaseInterimPumpAndResultMatching(t *testing.T) {
	h := releaseHost(t, "on go\nend go")
	h.ok("stop", `"group":"g","script":"s","reason":"done"`)
	expectRelease(t, h.send("pump", `"group":"g",`+now), "api", "stop")
	// Both an unrelated worker call and another kind of result leave release
	// pending. No stop report or final reply has escaped before the ack.
	if err := must(t, h.result("op-result", `"result":null`), "err"); err["kind"] != "protocol error" {
		t.Fatal(show(err))
	}
	wrong := h.s.Send([]byte(fmt.Sprintf(`{"m":"release-result","ref":%d}`, h.ref+100)))
	if !strings.Contains(string(wrong), "protocol error") {
		t.Fatal(string(wrong))
	}
	if err := must(t, h.result("fingerprint", `"group":"g"`), "err"); err["kind"] != "protocol error" {
		t.Fatal(show(err))
	}
	expectRelease(t, h.result("release-result", ""), "z", "stop")
	done := must(t, h.result("release-result", ""), "ok")
	if done["state"] != "idle" && done["state"] != "stopped" {
		t.Fatal(show(done))
	}
	if !strings.Contains(strings.Join(lines(done["trace"]), "\n"), "stopped s reason=\"done\"") {
		t.Fatal(show(done))
	}
	if strings.Contains(strings.Join(lines(done["trace"]), "\n"), "release") {
		t.Fatal("release entered Trace", show(done))
	}
	h.ok("pump", `"group":"g",`+now)
}

func TestReleaseRevocationIsDrainedOnce(t *testing.T) {
	h := releaseHost(t, "on go\nend go")
	h.ok("revoke", `"group":"g","script":"s","grant":"api"`)
	expectRelease(t, h.send("pump", `"group":"g",`+now), "api", "revoke")
	must(t, h.result("release-result", ""), "ok")
	h.ok("revoke", `"group":"g","script":"s","grant":"api"`)
	h.ok("revoke", `"group":"g","script":"s","grant":"unknown"`)
	h.ok("pump", `"group":"g",`+now)
}

func TestReleaseDisableFollowsAutomaticOperation(t *testing.T) {
	h := newHost(t)
	h.ok("define-capability", `"name":"api","release":true,"ops":[{"name":"open","mode":"immediate","result":"nothing","scope":{"Opens":"file","Abandon":"close"}},{"name":"close","mode":"immediate","result":"nothing","scope":{"Closes":"file"}}]`)
	grant := h.ok("grant", `"capability":"api","ops":"all"`)["grant"]
	h.ok("new-group", `"group":"g","name":"g","trace":true`)
	h.ok("load", fmt.Sprintf(`"group":"g","name":"s","source":%q,"grants":{"api":%v}`, "on go\nask api to open\nend go", grant))
	h.ok("deliver", `"group":"g","to":{"script":"s"},"message":{"name":"go"}`)
	must(t, h.send("pump", `"group":"g",`+now), "need")
	need := must(t, h.result("op-result", `"result":null`), "need")
	if need["operation"] != "close" || need["automatic"] != true {
		t.Fatal(show(need))
	}
	expectRelease(t, h.result("op-result", `"hostError":"abandon failed"`), "api", "disable")
	done := must(t, h.result("release-result", ""), "ok")
	trace := strings.Join(lines(done["trace"]), "\n")
	if !strings.Contains(trace, "effect-failure ") {
		t.Fatal(show(done))
	}
}

func TestReloadWaitsForReleaseResultsAndRejectsWithoutRelease(t *testing.T) {
	h := releaseHost(t, "on go\nend go")
	must(t, h.send("reload", `"group":"g","script":"s","source":"on"`), "err")
	expectRelease(t, h.send("reload", `"group":"g","script":"s","source":"on go\nreturn 2\nend go","carry":true`), "api", "reload")
	expectRelease(t, h.result("release-result", ""), "z", "reload")
	done := must(t, h.result("release-result", ""), "ok")
	if len(done["reports"].([]any)) == 0 {
		t.Fatal(show(done))
	}
	h.ok("request", `"group":"g","to":{"script":"s"},"message":{"name":"go"}`)
	if end := onlyReport(t, h.ok("pump", `"group":"g",`+now)); end["result"] != float64(2) {
		t.Fatal(show(end))
	}
}

func TestReplaceLibraryWaitsForReleaseResults(t *testing.T) {
	h := newHost(t)
	compile := func(source string) any {
		t.Helper()
		return h.ok("compile-library", fmt.Sprintf(`"name":"helper","version":"1","source":%q`, source))["identity"]
	}
	original := compile("function f\nreturn 1\nend f")
	h.ok("define-capability", `"name":"api","release":true,"ops":[]`)
	grant := h.ok("grant", `"capability":"api","ops":"all"`)["grant"]
	h.ok("new-group", `"group":"g","name":"g","trace":true`)
	h.ok("add-library", `"group":"g","identity":`+show(original))
	h.ok("load", fmt.Sprintf(`"group":"g","name":"s","source":%q,"grants":{"api":%v}`, "use f from helper\non go\nreturn f()\nend go", grant))
	h.ok("pump", `"group":"g",`+now)
	rejected := compile("function other\nreturn 2\nend other")
	must(t, h.send("replace-library", `"group":"g","identity":`+show(rejected)), "err")
	updated := compile("function f\nreturn 2\nend f")
	expectRelease(t, h.send("replace-library", `"group":"g","identity":`+show(updated)), "api", "reload")
	must(t, h.result("release-result", ""), "ok")
	h.ok("request", `"group":"g","to":{"script":"s"},"message":{"name":"go"}`)
	if end := onlyReport(t, h.ok("pump", `"group":"g",`+now)); end["result"] != float64(2) {
		t.Fatal(show(end))
	}
}
