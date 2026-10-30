package zigwasm

import (
	"encoding/json"
	"slices"
	"testing"
)

// Exercise the checked-in reactor through the same WASI exports as the Go
// adapter, so an old artifact cannot silently drop the analysis interface.
func TestEmbeddedReactorAnalysis(t *testing.T) {
	ctx := t.Context()
	engine, err := NewEngine(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	defer engine.Close(ctx)
	reactor, err := engine.Instantiate(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer reactor.Close(ctx)
	var ref int
	exchange := func(message map[string]any) map[string]json.RawMessage {
		t.Helper()
		ref++
		message["ref"] = ref
		frame, err := json.Marshal(message)
		if err != nil {
			t.Fatal(err)
		}
		reply, err := reactor.Frame(ctx, frame)
		if err != nil {
			t.Fatal(err)
		}
		var envelope struct {
			Ref   int                        `json:"ref"`
			OK    map[string]json.RawMessage `json:"ok"`
			Trace []json.RawMessage          `json:"trace"`
		}
		if err := json.Unmarshal(reply, &envelope); err != nil {
			t.Fatal(err)
		}
		if envelope.Ref != ref || envelope.OK == nil || len(envelope.Trace) != 0 {
			t.Fatalf("unexpected analysis reply: %s", reply)
		}
		return envelope.OK
	}
	hello := exchange(map[string]any{"m": "hello", "protocol": 1, "features": []string{"analysis-v1"}})
	var features []string
	if err := json.Unmarshal(hello["features"], &features); err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(features, "analysis-v1") {
		t.Fatal("embedded reactor does not advertise analysis-v1")
	}
	entry := exchange(map[string]any{"m": "analyze-entry", "source": "put 1 into total"})
	if string(entry["kind"]) != `"statement"` || string(entry["implicit"]) != `["total"]` {
		t.Fatalf("unexpected Entry analysis: %s", entry)
	}
	source := exchange(map[string]any{"m": "analyze-source", "source": "--| A value.\nconstant answer = 42"})
	var declarations []struct {
		Name string `json:"name"`
		Doc  string `json:"doc"`
	}
	if err := json.Unmarshal(source["declarations"], &declarations); err != nil {
		t.Fatal(err)
	}
	if len(declarations) != 1 || declarations[0].Name != "answer" || declarations[0].Doc != "A value." {
		t.Fatalf("unexpected declarations: %+v", declarations)
	}
	catalogue := exchange(map[string]any{"m": "analysis-catalogue"})
	for _, field := range []string{"builtins", "libraries", "inspectReader"} {
		if len(catalogue[field]) == 0 {
			t.Fatalf("catalogue missing %s", field)
		}
	}
	name := exchange(map[string]any{"m": "message-name", "name": "move:to:", "arity": 2})
	if string(name["valid"]) != "true" {
		t.Fatalf("valid Selector refused: %s", name)
	}
}
