package messagelayer

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestDeepScriptReplies(t *testing.T) {
	h := newHost(t)
	h.setup(`[{"name":"take","mode":"immediate","args":["any"],"result":"number","cost":{"fuel":1}}]`,
		"on go\nput 1 into v\nrepeat 200 times\nput [v] into v\nend repeat\nask api to take v\nreturn v\nend go\n", "")
	h.ok("request", `"group":"g","to":{"script":"s"},"message":{"name":"go"}`)
	check := func(v any) {
		t.Helper()
		for range 200 {
			items, ok := v.([]any)
			if !ok || len(items) != 1 {
				t.Fatal("lost nesting in Script-produced Value")
			}
			v = items[0]
		}
		if v != float64(1) {
			t.Fatalf("lost leaf: %v", v)
		}
	}
	need := must(t, h.send("pump", `"group":"g",`+now), "need")
	check(need["args"].([]any)[0])
	end := onlyReport(t, must(t, h.result("op-result", `"result":42`), "ok"))
	if end["outcome"] != "completed" {
		t.Fatal(show(end))
	}
	check(end["result"])
	h.ok("add", `"a":20,"b":22`)
}

func TestDeepFrameHostExchange(t *testing.T) {
	h := newHost(t)
	h.setup(`[{"name":"echo","mode":"immediate","args":["any"],"result":"any","cost":{"fuel":1}}]`,
		"on echo v\nask api to echo v\nreturn it\nend echo\n", "")
	value := strings.Repeat("[", 20_000) + "1" + strings.Repeat("]", 20_000)
	h.ok("request", `"group":"g","to":{"script":"s"},"message":{"name":"echo","args":[`+value+`]}`)
	need := h.s.Send([]byte(fmt.Sprintf(`{"m":"pump","ref":%d,"group":"g",%s}`, h.ref+1, now)))
	if !bytes.Contains(need, []byte(`"need"`)) || !bytes.Contains(need, []byte(value)) {
		t.Fatal("deep request did not reach Host Operation")
	}
	reply := h.s.Send([]byte(fmt.Sprintf(`{"m":"op-result","ref":%d,"result":%s}`, h.ref+1, value)))
	if !bytes.Contains(reply, []byte(`"completed"`)) || !bytes.Contains(reply, []byte(`"result":`+value)) {
		t.Fatal("lost deep Host result")
	}
}

func TestReplyEnvelopeEncoding(t *testing.T) {
	// Preserve encoding/json's envelope escaping, ordering, typed ids, and
	// empty-versus-null lists while bypassing only Value revalidation.
	for i, value := range []any{
		map[string]any{"z": "<>&\n\"\\", "a": []any{true, nil, 42, []string{"id"}}},
		map[string]any{"empty": []json.RawMessage{}, "null": []json.RawMessage(nil), "value": json.RawMessage(`{"$dec":"2.50"}`)},
		map[string]any(nil), []any(nil), []any{}, json.RawMessage(nil),
	} {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			want, err := json.Marshal(value)
			if err != nil {
				t.Fatal(err)
			}
			got, err := marshalReply(value)
			if err != nil || !bytes.Equal(got, want) {
				t.Fatalf("got %s (%v), want %s", got, err, want)
			}
		})
	}
	if got := mustMarshal(map[string]any{"unsupported": make(chan int)}); !bytes.Contains(got, []byte(`"protocol error"`)) {
		t.Fatalf("lost encoding failure: %s", got)
	}
}

func TestReplyPreservesDeepValueEncoding(t *testing.T) {
	// The Core has already encoded this Value. JSON's 10,000-level input
	// validation must not be applied again when assembling its reply.
	value := json.RawMessage(strings.Repeat("[", 100_000) + `{"$dec":"2.50"}` + strings.Repeat("]", 100_000))
	for _, reply := range []struct {
		name           string
		frame          []byte
		prefix, suffix string
	}{
		{"report", replyFrame(7, map[string]any{"reports": []any{map[string]any{"kind": "run end", "result": value}}}, nil), `{"ok":{"reports":[{"kind":"run end","result":`, `}]},"ref":7}`},
		{"need", mustMarshal(map[string]any{"ref": 7, "need": map[string]any{"args": []json.RawMessage{value}, "m": "op"}}), `{"need":{"args":[`, `],"m":"op"},"ref":7}`},
	} {
		t.Run(reply.name, func(t *testing.T) {
			want := append([]byte(reply.prefix), value...)
			want = append(want, reply.suffix...)
			if !bytes.Equal(reply.frame, want) {
				t.Fatalf("lost deep Value Encoding: got %d bytes, want %d", len(reply.frame), len(want))
			}
		})
	}
}
