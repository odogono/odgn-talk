package messagelayer

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestSourceNestingIsALoadError(t *testing.T) {
	h := newHost(t)
	h.ok("new-group", `"group":"g","name":"g"`)
	source := "on go\nreturn " + strings.Repeat("(", 200) + "1" + strings.Repeat(")", 200) + "\nend go\n"
	reply := h.send("load", fmt.Sprintf(`"group":"g","name":"deep","source":%q`, source))
	err := must(t, reply, "err")
	if err["kind"] != "load error" {
		t.Fatal(show(err))
	}
	h.ok("load", `"group":"g","name":"deep","source":"on go\nreturn 42\nend go\n"`)
	h.ok("add", `"a":20,"b":22`)
}

func TestFrameNestingHasNoTransportLimit(t *testing.T) {
	s := NewSession()
	frame := `{"m":"hello","ref":1,"protocol":1,"ignored":` + strings.Repeat("[", 200) + "1" + strings.Repeat("]", 200) + "}"
	var reply map[string]any
	if err := json.Unmarshal(s.Send([]byte(frame)), &reply); err != nil {
		t.Fatal(err)
	}
	must(t, reply, "ok")
	good := s.Send([]byte(`{"m":"add","ref":2,"a":20,"b":22}`))
	if err := json.Unmarshal(good, &reply); err != nil {
		t.Fatal(err)
	}
	if must(t, reply, "ok")["value"] != float64(42) {
		t.Fatal(show(reply))
	}
}

func TestDeepFramesAndQuotedDelimiters(t *testing.T) {
	for _, shape := range []struct{ name, open, close string }{
		{"arrays", "[", "]"}, {"objects", `{"a":`, "}"},
	} {
		for _, depth := range []int{10_000, 100_000} {
			t.Run(fmt.Sprintf("%s/%d", shape.name, depth), func(t *testing.T) {
				s := NewSession()
				frame := `{"m":"hello","ref":1,"protocol":1,"ignored":` + strings.Repeat(shape.open, depth) + "1" + strings.Repeat(shape.close, depth) + "}"
				var reply map[string]any
				if err := json.Unmarshal(s.Send([]byte(frame)), &reply); err != nil {
					t.Fatal(err)
				}
				must(t, reply, "ok")
			})
		}
	}
	h := newHost(t)
	// JSON quoting, escaped quotes and backslashes never add structural depth.
	text := strings.Repeat(`[{"\"\\}]`, 1000)
	h.ok("hello", fmt.Sprintf(`"protocol":1,"ignored":%q`, text))
	h.ok("hello", `"protocol":1,"ignored":[]`)
}

func TestDeepFrameLeavesPendingHostExchangeUsable(t *testing.T) {
	h := newHost(t)
	h.setup(`[{"name":"echo","mode":"immediate","args":["number"],"result":"number","cost":{"fuel":1}}]`,
		"on go\nask api to echo 42\nreturn it\nend go\n", "")
	h.ok("request", `"group":"g","to":{"script":"s"},"message":{"name":"go"}`)
	must(t, h.send("pump", `"group":"g",`+now), "need")
	frame := fmt.Sprintf(`{"m":"op-result","ref":%d,"result":`, h.ref) + strings.Repeat("[", 100_000) + "1" + strings.Repeat("]", 100_000)
	var reply map[string]any
	if err := json.Unmarshal(h.s.Send([]byte(frame)), &reply); err != nil {
		t.Fatal(err)
	}
	if must(t, reply, "err")["kind"] != "protocol error" {
		t.Fatal(show(reply))
	}
	end := onlyReport(t, must(t, h.result("op-result", `"result":42`), "ok"))
	if end["outcome"] != "completed" || end["result"] != float64(42) {
		t.Fatal(show(end))
	}
}

func TestDeepFrameValueAndReply(t *testing.T) {
	for _, shape := range []struct{ open, close string }{{"[", "]"}, {`{"a":`, "}"}} {
		value := strings.Repeat(shape.open, 100_000) + `{"$dec":"2.50"}` + strings.Repeat(shape.close, 100_000)
		s := NewSession()
		reply := s.Send([]byte(`{"m":"add","ref":7,"a":` + value + `,"b":1}`))
		var f fields
		if err := unmarshalFrame(reply, &f); err != nil {
			t.Fatal(err)
		}
		ok, err := f.sub("ok")
		if err != nil {
			t.Fatal(err)
		}
		fail, err := ok.sub("fail")
		if err != nil {
			t.Fatal(err)
		}
		code, err := fail.str("code")
		if err != nil || code != "wrong kind" {
			t.Fatalf("unexpected failure: %s %v", code, err)
		}
		data, err := fail.sub("data")
		if err != nil {
			t.Fatal(err)
		}
		if string(data["value"]) != value {
			t.Fatal("lost deep Value in reply")
		}
	}
}
