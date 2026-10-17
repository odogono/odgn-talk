package session

import (
	"reflect"
	"strings"
	"testing"

	talk "github.com/odogono/odgn-talk/impl/go"
)

func TestTraceErrorMessageProvenance(t *testing.T) {
	for _, origin := range []string{"Core", "Script", "Host"} {
		t.Run(origin, func(t *testing.T) {
			h := New(Environment{})
			for _, source := range []string{
				"script variable caught",
				"on error e\n put e into caught\n send seen with [e] to session\nend error",
				"on seen x\n return x\nend seen",
				":trace error", ":trace seen",
			} {
				if rows := h.Input(source); len(rows) != 0 {
					t.Fatal(source, rows)
				}
			}
			var rows []string
			switch origin {
			case "Core":
				rows = h.Input("1 / 0")
			case "Script":
				// Identical wording and a catalogue code must not make this a
				// Core-generated message.
				rows = h.Input(`throw {code: "division by zero", message: "Division by zero"}`)
			case "Host":
				code, _ := talk.Text("division by zero")
				message, _ := talk.Text("Division by zero")
				e, err := talk.Map(talk.KV("code", code), talk.KV("message", message))
				if err != nil {
					t.Fatal(err)
				}
				if _, err := h.script.Deliver(talk.Message{Name: "error", Args: []talk.Value{e}}); err != nil {
					t.Fatal(err)
				}
				rows = h.Tick()
			}
			traced := 0
			for _, row := range rows {
				if !strings.HasPrefix(row, "trace ") || !strings.Contains(row, `code: "division by zero"`) {
					continue
				}
				traced++
				if strings.Contains(row, "message:") != (origin != "Core") {
					t.Fatalf("%s message provenance lost: %s", origin, row)
				}
			}
			// Direct error argument, nested relay argument and nested result.
			if traced != 3 {
				t.Fatalf("want three error observations, got %d: %v", traced, rows)
			}
			if got := h.Input("the message of caught"); !reflect.DeepEqual(got, []string{`"Division by zero"`}) {
				t.Fatalf("handler lost its full error value: %v", got)
			}
		})
	}
}

func TestFuelEntryContinuesLikeAnEntry(t *testing.T) {
	h := New(Environment{})
	for source, more := range map[string]bool{":fuel repeat 2 times": true, ":fuel repeat 2 times\nsay 1\nend repeat": false, ":fuel 1 + 2": false, ":fuel": false, ":runs": false, ":trace greet": false} {
		if got := h.NeedsMore(source); got != more {
			t.Errorf("NeedsMore(%q) = %v", source, got)
		}
	}
}

// A measured Entry that yields to `read` prints its pending row, then its
// final row at the Host call where its family settles.
func TestFuelRowsAtYieldAndSettlement(t *testing.T) {
	h := New(Environment{})
	h.Input(":clock virtual 2026-09-30T10:00:00Z")
	out := h.Input(":fuel ask console to read and wait")
	if !reflect.DeepEqual(out, []string{`fuel {entry: "entry1", fuel: 14, state: "pending", interrupted: false, runs: 1, queued: 0}`}) {
		t.Fatal(out)
	}
	if h.Waiting().Kind != "read" {
		t.Fatal(h.Waiting())
	}
	out = h.Read("hi")
	if !reflect.DeepEqual(out, []string{`fuel {entry: "entry1", fuel: 19, state: "complete", interrupted: false, runs: 0, queued: 0}`}) {
		t.Fatal(out)
	}
	if out := h.Tick(); len(out) != 0 {
		t.Fatal("a settled measurement printed again", out)
	}
}
