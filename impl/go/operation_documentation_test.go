package northtalk

import (
	"bytes"
	"testing"
)

func TestOperationDocumentationDoesNotChangeIdentity(t *testing.T) {
	makeGrant := func(description string) (*Core, *Grant) {
		c := New()
		def, err := c.DefineCapability("api", Operation{
			Name: "read", Mode: Immediate, Description: description, Examples: []string{description},
			Do: func(*Call, []Value) (Value, error) { t.Fatal("unexpected call"); return Nothing, nil },
		})
		if err != nil {
			t.Fatal(err)
		}
		return c, def.GrantAll(nil)
	}
	c, original := makeGrant("Original documentation")
	revisedCore, revised := makeGrant("Revised documentation")
	makeGroup := func(c *Core, grant *Grant) *Group {
		g := c.NewGroup(GroupOptions{Name: "g"})
		_, err := g.Load(LoadOptions{Name: "s", Source: "on go\n ask api to read\nend go", Grants: map[string]*Grant{"api": grant}})
		if err != nil {
			t.Fatal(err)
		}
		return g
	}
	g := makeGroup(c, original)
	if g.Fingerprint() != makeGroup(revisedCore, revised).Fingerprint() {
		t.Fatal("documentation changed Fingerprint")
	}
	saved, err := g.Save()
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(saved, []byte("Original documentation")) {
		t.Fatal("save contains documentation")
	}
	restored, _, err := revisedCore.Restore(saved, RestoreOptions{Grants: func(string, string) *Grant { return revised }})
	if err != nil {
		t.Fatal(err)
	}
	if restored.Fingerprint() != g.Fingerprint() {
		t.Fatal("restored Fingerprint differs")
	}
}
