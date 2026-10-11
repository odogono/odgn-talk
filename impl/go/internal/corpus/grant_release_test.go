package corpus

import (
	talk "github.com/odogono/odgn-talk/impl/go"
	"reflect"
	"testing"
)

func TestTraceReplayGrantReleaseBoundaries(t *testing.T) {
	h, err := NewReplayHost(Setup{"scripts": []any{}})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	var events []string
	d, err := talk.New().DefineCapability("resource", talk.Operation{Name: "touch", Mode: talk.Immediate, Result: talk.NothingShape, Do: func(*talk.Call, []talk.Value) (talk.Value, error) { return talk.Nothing, nil }}, talk.WithReleaseHook(func(ctx talk.GrantContext) { events = append(events, string(ctx.Reason)+":"+ctx.GrantName) }))
	if err != nil {
		t.Fatal(err)
	}
	_, err = h.Group().Load(talk.LoadOptions{Name: "s", Source: "on go\nask api to touch\nend go", Grants: map[string]*talk.Grant{"api": d.GrantAll("api"), "z": d.GrantAll("z")}})
	if err != nil {
		t.Fatal(err)
	}
	for _, input := range []string{"> revoke s grant=api", "> pump clock=2026-10-11T12:00:00Z", `> reload s carry=no source="on go" & newline & "end go"`, `> stop s reason="done"`, "> pump clock=2026-10-11T12:00:00Z"} {
		if err := h.Apply(input); err != nil {
			t.Fatal(input, err)
		}
	}
	if !reflect.DeepEqual(events, []string{"revoke:api", "reload:api", "reload:z", "stop:z"}) {
		t.Fatal(events)
	}
}
