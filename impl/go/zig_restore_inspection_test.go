package northtalk

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/odogono/odgn-talk/impl/go/internal/docs"
)

func TestRestoredObjectInspectionKeepsDisposedState(t *testing.T) {
	core := New()
	kind, err := core.DefineObjectKind(ObjectKindDef{Name: "Item"})
	if err != nil {
		t.Fatal(err)
	}
	g := core.NewGroup(GroupOptions{})
	for _, id := range []string{"live", "lost", "gone"} {
		object, err := g.Object(kind, id, nil)
		if err != nil {
			t.Fatal(err)
		}
		if id == "gone" {
			if err := g.Dispose(object); err != nil {
				t.Fatal(err)
			}
		}
	}
	if _, err := g.Pump(time.Unix(0, 0), PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	save, err := g.Save()
	if err != nil {
		t.Fatal(err)
	}
	restored, _, err := core.Restore(save, RestoreOptions{Resolve: func(kind, id string) (any, bool) { return nil, id == "live" }})
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"live", "lost", "gone"} {
		object, ok := restored.ObjectByID("Item", id)
		if !ok {
			t.Fatal("missing restored object", id)
		}
		rows, _ := docs.Inspection(object.Value(), docs.Function)
		want := fmt.Sprintf(`object {kind: "Item", id: %q, disposed: %t}`, id, id != "live")
		if !strings.Contains(strings.Join(rows, "\n"), want) {
			t.Fatalf("inspection: got %v, missing %s", rows, want)
		}
	}
}
