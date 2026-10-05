package corpus

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// These are runner-local regressions, not blessings of new Corpus expectations.
func replayValueInputs(t *testing.T, source string, setup Setup, inputs string) ([]string, error) {
	t.Helper()
	mode := setup["operations"].([]any)[0].(Setup)["mode"]
	if mode == "immediate" {
		source = strings.ReplaceAll(source, " and wait", "")
	}
	if mode == "suspending" {
		source = strings.ReplaceAll(source, "ask callbacks to get\n", "ask callbacks to get and wait\n")
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "home.talk"), []byte(source), 0600); err != nil {
		t.Fatal(err)
	}
	script := Setup{"name": "home", "source": "home.talk", "grants": Setup{"callbacks": Setup{"ops": "all"}}}
	if standards, ok := setup["standard"].([]any); ok && len(standards) > 0 {
		script["grants"].(Setup)["console"] = Setup{"ops": "all"}
	}
	if _, ok := setup["objects"]; ok {
		script["objects"] = Setup{"box": Setup{"kind": "box", "id": "1"}}
	}
	setup["scripts"] = []any{script}
	records, err := ParseTrace(inputs)
	if err != nil {
		t.Fatal(err)
	}
	return (executionBackend{}).Run(Case{Dir: dir, Setup: setup}, records)
}

func callbackSetup(mode string, args []any) Setup {
	for i, arg := range args {
		args[i] = Setup{"optional": arg}
	}
	return Setup{"operations": []any{Setup{"capability": "callbacks", "name": "get", "mode": mode, "args": args, "result": "value"}}}
}

const callbackSource = `script variable total = 0
script variable saved = nothing
function twice n
 return n * 2
end twice
on accept bundle
 put item 1 of the callback of bundle into fn
 put fn(3) into total
end accept
on immediate
 ask callbacks to get
 put item 1 of the callback of it into fn
 put fn(3) into total
end immediate
on pending
 ask callbacks to get and wait
 put item 1 of the callback of it into fn
 put fn(3) into total
end pending
`

const nestedCallback = `{callback: [<function home:twice>]}`
const replayClock = "> pump clock=2026-09-30T09:00:00Z\n"

func TestReplayReceivesNestedCallbacksAtHostBoundaries(t *testing.T) {
	for _, boundary := range []string{"result", "error", "unhandled", "inspection", "immediate", "fire", "suspending", "console", "property"} {
		t.Run(boundary, func(t *testing.T) {
			setup := callbackSetup("immediate", nil)
			body, extra, inputs := "return {callback: [twice]}", "", "> load home\n"
			switch boundary {
			case "error":
				body = `throw {code: "exported", callback: [twice]}`
			case "unhandled":
				body = "send missing with {callback: [twice]} to me"
			case "inspection":
				body = "put {callback: [twice]} into saved"
			case "immediate":
				setup = callbackSetup("immediate", []any{"value"})
				body = "ask callbacks to get {callback: [twice]}\nput item 1 of the callback of it into fn\nput fn(3) into total"
				inputs += "> stub callbacks.get value=" + nestedCallback + "\n"
			case "fire":
				setup["operations"] = append(setup["operations"].([]any), Setup{"capability": "callbacks", "name": "accept", "mode": "fire-and-forget", "args": []any{"value"}})
				body = "tell callbacks to accept {callback: [twice]}\nask callbacks to get\nput item 1 of the callback of it into fn\nput fn(3) into total"
				inputs += "> stub callbacks.get value=" + nestedCallback + "\n"
			case "suspending":
				setup = callbackSetup("suspending", []any{"value"})
				body = "ask callbacks to get {callback: [twice]} and wait\nput item 1 of the callback of it into fn\nput fn(3) into total"
				extra = "> answer home/r1.c1 value=" + nestedCallback + "\n" + replayClock
			case "console":
				setup["standard"] = []any{Setup{"capability": "console", "costs": Setup{"write": Setup{}, "read": Setup{}}}}
				body = "say {callback: [twice]}\nask callbacks to get\nput item 1 of the callback of it into fn\nput fn(3) into total"
				inputs += "> stub callbacks.get value=" + nestedCallback + "\n"
			case "property":
				setup["objectKinds"] = []any{Setup{"name": "box", "props": []any{Setup{"name": "callback", "shape": "value"}}}}
				setup["objects"] = []any{Setup{"kind": "box", "id": "1", "props": Setup{"callback": "nothing"}}}
				body = "set the callback of box to {callback: [twice]}\nask callbacks to get\nput item 1 of the callback of it into fn\nput fn(3) into total"
				inputs += "> stub callbacks.get value=" + nestedCallback + "\n"
			}
			inputs += "> deliver d1 to=home message=exported\n" + replayClock + extra
			if boundary == "inspection" {
				inputs += "> vars\n"
			}
			if boundary == "result" || boundary == "error" || boundary == "unhandled" || boundary == "inspection" {
				inputs += "> deliver d2 to=home message=accept args=[" + nestedCallback + "]\n" + replayClock
			}
			inputs += "> vars\n"
			lines, err := replayValueInputs(t, callbackSource+"on exported\n"+body+"\nend exported\n", setup, inputs)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(strings.Join(lines, "\n"), "vars home total=6") {
				t.Fatalf("callback did not execute:\n%s", strings.Join(lines, "\n"))
			}
		})
	}
}

func TestReplayUsesLatestReceivedCallbackAfterReload(t *testing.T) {
	source := callbackSource + "on exported\nreturn {callback: [twice]}\nend exported\n"
	replacement := strings.ReplaceAll(strings.Replace(source, "n * 2", "n * 3", 1), " and wait", "")
	// Display-form source strings preserve newlines as concatenated text pieces.
	quoted := `"` + strings.ReplaceAll(strings.TrimSuffix(replacement, "\n"), "\n", `" & newline & "`) + `" & newline`
	inputs := "> load home\n> deliver d1 to=home message=exported\n" + replayClock +
		"> reload home carry=yes source=" + quoted + "\n> deliver d2 to=home message=exported\n" + replayClock +
		"> stub callbacks.get value=" + nestedCallback + "\n> deliver d3 to=home message=immediate\n" + replayClock + "> vars\n"
	lines, err := replayValueInputs(t, source, callbackSetup("immediate", nil), inputs)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(lines, "\n"), "vars home total=9") {
		t.Fatalf("latest callback not used:\n%s", strings.Join(lines, "\n"))
	}
}

func TestReplayRefusesUnreceivedCallbackEvenWhenTraceNamesIt(t *testing.T) {
	inputs := "> load home\nrun home/r99 outcome=completed value=<function home:twice> fuel=0 alloc=0\n> deliver d1 to=home message=pending\n" + replayClock + "> answer home/r1.c1 value=" + nestedCallback + "\n"
	_, err := replayValueInputs(t, callbackSource, callbackSetup("suspending", nil), inputs)
	if err == nil || !strings.Contains(err.Error(), "unknown replay handle <function home:twice>") {
		t.Fatalf("expected an unreceived Function Value refusal, got %v", err)
	}
}

func TestReplayCallValueAcceptsNestedCallbackArguments(t *testing.T) {
	source := callbackSource + `function apply bundle
 put item 1 of the callback of bundle into fn
 put fn(3) into total
 return total
end apply
on exported
 return [apply, twice]
end exported
`
	inputs := "> load home\n> deliver d1 to=home message=exported\n" + replayClock +
		"> call-value d2 fn=<function home:apply> args=[" + nestedCallback + "]\n" + replayClock + "> vars\n"
	lines, err := replayValueInputs(t, source, callbackSetup("immediate", nil), inputs)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(lines, "\n"), "vars home total=6") {
		t.Fatalf("nested call argument not bound:\n%s", strings.Join(lines, "\n"))
	}
}

func TestReplayRefusesUnknownCallbackInStub(t *testing.T) {
	inputs := "> load home\n> stub callbacks.get value=" + nestedCallback + "\n> deliver d1 to=home message=immediate\n" + replayClock + "> vars\n"
	lines, err := replayValueInputs(t, callbackSource, callbackSetup("immediate", nil), inputs)
	if err != nil {
		t.Fatal(err)
	}
	output := strings.Join(lines, "\n")
	if !strings.Contains(output, "call-failed home/r1.c1 op=callbacks.get") || !strings.Contains(output, "vars home total=0") {
		t.Fatalf("unreceived Stub callback accepted:\n%s", output)
	}
}
