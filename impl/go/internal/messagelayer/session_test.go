package messagelayer

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

// host drives a Session as a Host in another language would: one JSON frame
// at a time.
type host struct {
	t   *testing.T
	s   *Session
	ref int
}

func newHost(t *testing.T) *host { return &host{t: t, s: NewSession()} }

// send sends message m under a fresh ref and returns the decoded reply.
func (h *host) send(m string, fields string) map[string]any {
	h.t.Helper()
	h.ref++
	return h.frame(fmt.Sprintf(`{"m":%q,"ref":%d%s}`, m, h.ref, comma(fields)))
}

// result answers the need the last message is waiting on.
func (h *host) result(m string, fields string) map[string]any {
	h.t.Helper()
	return h.frame(fmt.Sprintf(`{"m":%q,"ref":%d%s}`, m, h.ref, comma(fields)))
}

func (h *host) frame(frame string) map[string]any {
	h.t.Helper()
	var out map[string]any
	reply := h.s.Send([]byte(frame))
	if err := json.Unmarshal(reply, &out); err != nil {
		h.t.Fatalf("reply %s: %v", reply, err)
	}
	if ref, _ := out["ref"].(float64); int(ref) != h.ref {
		h.t.Fatalf("reply ref %v for ref %d: %s", out["ref"], h.ref, reply)
	}
	return out
}

func (h *host) ok(m string, fields string) map[string]any {
	h.t.Helper()
	return must(h.t, h.send(m, fields), "ok")
}

func must(t *testing.T, reply map[string]any, key string) map[string]any {
	t.Helper()
	got, ok := reply[key].(map[string]any)
	if !ok {
		t.Fatalf("want %s, got %s", key, show(reply))
	}
	return got
}

func comma(fields string) string {
	if fields == "" {
		return ""
	}
	return "," + fields
}

func show(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

const now = `"now":"2026-10-09T12:00:00Z"`

// setup defines api with the given Operations and loads source granted all of
// them, as Script s in Group g.
func (h *host) setup(ops string, source string, extra string) {
	h.t.Helper()
	h.ok("hello", `"protocol":1`)
	h.ok("define-capability", `"name":"api","ops":`+ops)
	grant := h.ok("grant", `"capability":"api","ops":"all"`)["grant"]
	h.ok("new-group", `"group":"g","name":"g","trace":true`)
	h.ok("load", fmt.Sprintf(`"group":"g","name":"s","source":%q,"grants":{"api":%v}%s`, source, grant, comma(extra)))
}

func onlyReport(t *testing.T, ok map[string]any) map[string]any {
	t.Helper()
	var ends []map[string]any
	for _, r := range ok["reports"].([]any) {
		if r := r.(map[string]any); r["kind"] == "run end" {
			ends = append(ends, r)
		}
	}
	if len(ends) != 1 {
		t.Fatalf("want one run end, got %s", show(ok["reports"]))
	}
	return ends[0]
}

func TestHelloNamesTheCore(t *testing.T) {
	h := newHost(t)
	ok := h.ok("hello", `"protocol":1`)
	if ok["language"] == "" || !strings.HasPrefix(ok["core"].(string), "go/") || ok["saveFormat"] == "" {
		t.Fatal(show(ok))
	}
	if err := must(t, h.send("hello", `"protocol":2`), "err"); err["kind"] != "protocol error" {
		t.Fatal(show(err))
	}
}

func TestImmediateOperationIsAnInterimOp(t *testing.T) {
	h := newHost(t)
	h.setup(`[{"name":"double","mode":"immediate","args":["number"],"result":"number","cost":{"fuel":7}}]`,
		"on go n\n  ask api to double n\n  return it + 1\nend go", `"limits":{"fuelPerRun":1000}`)
	delivery := h.ok("request", `"group":"g","to":{"script":"s"},"message":{"name":"go","args":[20]}`)["delivery"]
	need := must(t, h.send("pump", `"group":"g",`+now), "need")
	if need["m"] != "op" || need["operation"] != "double" || need["capability"] != "api" || need["grant"] != "api" || need["mode"] != "immediate" || show(need["args"]) != "[20]" || need["call"] != "s/r1.c1" || need["automatic"] != false || need["now"] != "2026-10-09T12:00:00Z" {
		t.Fatal(show(need))
	}
	left, ok := need["fuelLeft"].(float64)
	if !ok || left <= 0 || left >= 1000 {
		t.Fatalf("fuelLeft %v", need["fuelLeft"])
	}
	done := must(t, h.result("op-result", `"result":40,"charged":3`), "ok")
	end := onlyReport(t, done)
	if end["delivery"] != delivery || end["outcome"] != "completed" || show(end["result"]) != "41" {
		t.Fatal(show(end))
	}
	if done["state"] != "idle" || show(done["abandoned"]) != "[]" {
		t.Fatal(show(done))
	}
	if !strings.Contains(strings.Join(lines(done["trace"]), "\n"), "op=api.double args=[20] result=40 charged=3") {
		t.Fatal(show(done["trace"]))
	}
}

func lines(v any) []string {
	var out []string
	for _, l := range v.([]any) {
		out = append(out, l.(string))
	}
	return out
}

func TestSuspendingOperationIsAnsweredByALaterMessage(t *testing.T) {
	h := newHost(t)
	h.setup(`[{"name":"fetch","mode":"suspending","result":"number","maxPending":5000}]`,
		"on go\n  ask api to fetch and wait\n  return it\nend go", "")
	h.ok("request", `"group":"g","to":{"script":"s"},"message":{"name":"go"}`)
	need := must(t, h.send("pump", `"group":"g",`+now), "need")
	if need["mode"] != "suspending" {
		t.Fatal(show(need))
	}
	parked := must(t, h.result("op-result", `"started":true`), "ok")
	if len(parked["reports"].([]any)) != 0 && hasRunEnd(parked) || parked["nextDeadline"] != "2026-10-09T12:00:05Z" {
		t.Fatal(show(parked))
	}
	h.ok("answer", fmt.Sprintf(`"group":"g","call":%q,"value":37`, need["call"]))
	if err := must(t, h.send("answer", fmt.Sprintf(`"group":"g","call":%q,"value":1`, need["call"])), "err"); err["kind"] != "protocol error" {
		t.Fatal("a second answer was accepted", show(err))
	}
	end := onlyReport(t, h.ok("pump", `"group":"g",`+now))
	if end["outcome"] != "completed" || show(end["result"]) != "37" {
		t.Fatal(show(end))
	}
}

func hasRunEnd(ok map[string]any) bool {
	for _, r := range ok["reports"].([]any) {
		if r.(map[string]any)["kind"] == "run end" {
			return true
		}
	}
	return false
}

func TestFailedSuspendingCallReachesTheScript(t *testing.T) {
	h := newHost(t)
	h.setup(`[{"name":"fetch","mode":"suspending","result":"number","maxPending":5000,"errors":[{"code":"not found"}]}]`,
		"on go\n  try\n    ask api to fetch and wait\n  catch e\n    return the code of e\n  end try\nend go", "")
	h.ok("request", `"group":"g","to":{"script":"s"},"message":{"name":"go"}`)
	need := must(t, h.send("pump", `"group":"g",`+now), "need")
	h.result("op-result", `"started":true`)
	h.ok("fail", fmt.Sprintf(`"group":"g","call":%q,"error":{"code":"not found","message":"no such key"}`, need["call"]))
	end := onlyReport(t, h.ok("pump", `"group":"g",`+now))
	if show(end["result"]) != `"not found"` {
		t.Fatal(show(end))
	}
}

func TestFireAndForgetIsDone(t *testing.T) {
	h := newHost(t)
	h.setup(`[{"name":"log","mode":"fire-and-forget","args":["text"]}]`, "on go\n  tell api to log \"hi\"\n  return 1\nend go", "")
	h.ok("request", `"group":"g","to":{"script":"s"},"message":{"name":"go"}`)
	need := must(t, h.send("pump", `"group":"g",`+now), "need")
	if need["mode"] != "fire-and-forget" || show(need["args"]) != `["hi"]` {
		t.Fatal(show(need))
	}
	if end := onlyReport(t, must(t, h.result("op-result", `"done":true`), "ok")); end["outcome"] != "completed" {
		t.Fatal(show(end))
	}
}

func TestOpResultFailures(t *testing.T) {
	for _, test := range []struct{ result, outcome, code string }{
		{`"fail":{"code":"bad","message":"declared","data":{"why":"x"}}`, "errored", "bad"},
		{`"hostError":"backend down"`, "errored", "host error"},
		{`"limit":true`, "limit fault", ""},
		{`"result":1,"charged":100000`, "limit fault", ""},
		{`"result":"not a number"`, "errored", "host error"},
		{`"started":true`, "errored", "host error"},
	} {
		t.Run(test.result, func(t *testing.T) {
			h := newHost(t)
			h.setup(`[{"name":"read","mode":"immediate","result":"number","errors":[{"code":"bad"}]}]`, "on go\n  ask api to read\n  return it\nend go", `"limits":{"fuelPerRun":1000}`)
			h.ok("request", `"group":"g","to":{"script":"s"},"message":{"name":"go"}`)
			must(t, h.send("pump", `"group":"g",`+now), "need")
			end := onlyReport(t, must(t, h.result("op-result", test.result), "ok"))
			code := ""
			if e, ok := end["error"].(map[string]any); ok {
				code = e["code"].(string)
			}
			if end["outcome"] != test.outcome || code != test.code {
				t.Fatal(show(end))
			}
		})
	}
}

func TestOnlyTheResultMayFollowANeed(t *testing.T) {
	h := newHost(t)
	h.setup(`[{"name":"read","mode":"immediate","result":"number"}]`, "on go\n  ask api to read\n  return it\nend go", "")
	h.ok("request", `"group":"g","to":{"script":"s"},"message":{"name":"go"}`)
	must(t, h.send("pump", `"group":"g",`+now), "need")
	if err := must(t, h.result("counters", `"group":"g","script":"s"`), "err"); err["kind"] != "protocol error" {
		t.Fatal(show(err))
	}
	// Another ref is refused too, and its reply echoes that ref.
	if reply := string(h.s.Send([]byte(`{"m":"counters","ref":99,"group":"g","script":"s"}`))); !strings.Contains(reply, `"ref":99`) || !strings.Contains(reply, "waiting") {
		t.Fatal(reply)
	}
	if end := onlyReport(t, must(t, h.result("op-result", `"result":5`), "ok")); show(end["result"]) != "5" {
		t.Fatal(show(end))
	}
}

func TestScriptFaultsNeverEndTheSession(t *testing.T) {
	h := newHost(t)
	h.ok("new-group", `"group":"g","name":"g"`)
	h.ok("load", `"group":"g","name":"s","source":"function down n\n  return down(n + 1) + 1\nend down\n\non spin\n  repeat forever\n  end repeat\nend spin\n\non boom\n  throw \"first\"\nend boom\n\non dive\n  return down(0)\nend dive","limits":{"fuelPerRun":5000}`)
	for _, test := range []struct{ message, outcome string }{{"spin", "limit fault"}, {"boom", "errored"}, {"dive", "limit fault"}} {
		for range 50 {
			h.ok("deliver", fmt.Sprintf(`"group":"g","to":{"script":"s"},"message":{"name":%q}`, test.message))
			if end := onlyReport(t, h.ok("pump", `"group":"g",`+now)); end["outcome"] != test.outcome {
				t.Fatal(show(end))
			}
		}
	}
	if counters := h.ok("counters", `"group":"g","script":"s"`); counters["runs"] != float64(150) {
		t.Fatal(show(counters))
	}
}

func TestErrorForms(t *testing.T) {
	h := newHost(t)
	h.ok("new-group", `"group":"g","name":"g"`)
	load := must(t, h.send("load", `"group":"g","name":"s","source":"on go\n  return nope\nend go"`), "err")
	if load["kind"] != "load error" || len(load["diagnostics"].([]any)) == 0 {
		t.Fatal(show(load))
	}
	for frame, kind := range map[string]string{
		`{"m":"nope","ref":%d}`:                   "protocol error",
		`{"m":"restore","ref":%d}`:                "protocol error",
		`{"m":"pump","ref":%d,"group":"missing"}`: "protocol error",
	} {
		h.ref++
		if err := must(t, h.frame(fmt.Sprintf(frame, h.ref)), "err"); err["kind"] != kind {
			t.Fatal(frame, show(err))
		}
	}
	if reply := h.s.Send([]byte("{")); !strings.Contains(string(reply), "protocol error") {
		t.Fatal(string(reply))
	}
	h.ok("load", `"group":"g","name":"t","source":"on go\nend go","limits":{"mailboxDepth":1}`)
	h.ok("deliver", `"group":"g","to":{"script":"t"},"message":{"name":"go"}`)
	if err := must(t, h.send("deliver", `"group":"g","to":{"script":"t"},"message":{"name":"go"}`), "err"); err["kind"] != "mailbox full" {
		t.Fatal(show(err))
	}
}

func TestAddAndValueEncoding(t *testing.T) {
	h := newHost(t)
	if ok := h.ok("add", `"a":{"$dec":"9007199254740993"},"b":1`); show(ok["value"]) != `{"$dec":"9007199254740994"}` {
		t.Fatal(show(ok))
	}
	if ok := h.ok("add", `"a":"x","b":1`); must(t, ok, "fail")["code"] == "" {
		t.Fatal(show(ok))
	}
}

func TestHostObjectsAndProperties(t *testing.T) {
	h := newHost(t)
	h.ok("define-object-kind", `"name":"lamp","props":[{"name":"state","shape":"text"},{"name":"watts","shape":"number","readOnly":true}]`)
	h.ok("new-group", `"group":"g","name":"g"`)
	h.ok("object", `"group":"g","kind":"lamp","id":"l1"`)
	h.ok("load", `"group":"g","name":"s","source":"on go\n  set the state of bulb to \"on\"\n  return [the state of bulb, the watts of bulb, the id of bulb]\nend go","objects":{"bulb":["lamp","l1"]}`)
	h.ok("request", `"group":"g","to":{"script":"s"},"message":{"name":"go"}`)
	set := must(t, h.send("pump", `"group":"g",`+now), "need")
	if set["m"] != "prop" || show(set["object"]) != `["lamp","l1"]` || set["prop"] != "state" || set["value"] != "on" {
		t.Fatal(show(set))
	}
	get := must(t, h.result("prop-result", `"ok":true`), "need")
	if get["prop"] != "state" || get["value"] != nil {
		t.Fatal(show(get))
	}
	watts := must(t, h.result("prop-result", `"value":"on"`), "need")
	end := onlyReport(t, must(t, h.result("prop-result", fmt.Sprintf(`"value":%d`, 60)), "ok"))
	if watts["prop"] != "watts" || show(end["result"]) != `["on",60,"l1"]` {
		t.Fatal(show(end))
	}
}

func TestDeliverToAnObjectAndUnhandled(t *testing.T) {
	h := newHost(t)
	h.ok("define-object-kind", `"name":"door"`)
	h.ok("new-group", `"group":"g","name":"g"`)
	h.ok("object", `"group":"g","kind":"door","id":"d1"`)
	h.ok("load", `"group":"g","name":"s","source":"on open\n  return 1\nend open","owner":["door","d1"]`)
	h.ok("deliver", `"group":"g","to":{"object":["door","d1"]},"message":{"name":"knock","args":[{"$object":["door","d1"]}]}`)
	ok := h.ok("pump", `"group":"g",`+now)
	var unhandled map[string]any
	for _, r := range ok["reports"].([]any) {
		if r := r.(map[string]any); r["kind"] == "unhandled" {
			unhandled = r
		}
	}
	if unhandled == nil || show(unhandled["target"]) != `{"$object":["door","d1"]}` || show(unhandled["message"]) != `{"args":[{"$object":["door","d1"]}],"name":"knock"}` {
		t.Fatal(show(ok))
	}
}

func TestStopAndAbandonedCalls(t *testing.T) {
	h := newHost(t)
	h.setup(`[{"name":"fetch","mode":"suspending","result":"number","maxPending":5000}]`, "on go\n  ask api to fetch and wait\n  return it\nend go", "")
	h.ok("request", `"group":"g","to":{"script":"s"},"message":{"name":"go"}`)
	need := must(t, h.send("pump", `"group":"g",`+now), "need")
	h.result("op-result", `"started":true`)
	h.ok("stop", `"group":"g","script":"s","reason":"done"`)
	ok := h.ok("pump", `"group":"g",`+now)
	if show(ok["abandoned"]) != fmt.Sprintf(`[%q]`, need["call"]) {
		t.Fatal(show(ok))
	}
	var stop map[string]any
	for _, r := range ok["reports"].([]any) {
		if r := r.(map[string]any); r["kind"] == "stop" {
			stop = r
		}
	}
	if stop == nil || stop["reason"] != "done" || show(stop["pendingCalls"]) != fmt.Sprintf(`[%q]`, need["call"]) {
		t.Fatal(show(ok))
	}
}

func TestSaveFingerprintAndGrants(t *testing.T) {
	h := newHost(t)
	h.setup(`[{"name":"read","mode":"immediate","result":"number"},{"name":"write","mode":"fire-and-forget"}]`, "on go\n  return 1\nend go", "")
	for _, m := range []string{"save", "fingerprint"} {
		if ok := h.ok(m, `"group":"g"`); !strings.HasPrefix(show(ok[m]), `{"$bytes":"`) {
			t.Fatal(show(ok))
		}
	}
	if ok := h.ok("grants", `"group":"g","script":"s"`); show(ok) != `{"api":["read","write"],"trace":[]}` && show(ok) != `{"api":["read","write"]}` {
		t.Fatal(show(ok))
	}
}

func TestClockStandardCapability(t *testing.T) {
	h := newHost(t)
	h.ok("standard-capability", `"name":"clock","costs":{"now":{"fuel":2}}`)
	grant := h.ok("grant", `"capability":"clock","ops":["now"]`)["grant"]
	h.ok("new-group", `"group":"g","name":"g"`)
	h.ok("load", fmt.Sprintf(`"group":"g","name":"s","source":"on go\n  ask clock to now\n  return it\nend go","grants":{"clock":%v}`, grant))
	h.ok("request", `"group":"g","to":{"script":"s"},"message":{"name":"go"}`)
	if end := onlyReport(t, h.ok("pump", `"group":"g",`+now)); show(end["result"]) != `{"$instant":"2026-10-09T12:00:00Z"}` {
		t.Fatal(show(end))
	}
	if err := must(t, h.send("standard-capability", `"name":"store"`), "err"); err["kind"] != "protocol error" {
		t.Fatal(show(err))
	}
}
