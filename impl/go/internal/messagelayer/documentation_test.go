package messagelayer

import (
	"fmt"
	"testing"
)

func TestOperationDocumentationValidation(t *testing.T) {
	for _, fields := range []string{
		`"description":null`, `"description":42`, `"description":[]`,
		`"examples":null`, `"examples":"source"`, `"examples":[null]`, `"examples":[1]`,
	} {
		t.Run(fields, func(t *testing.T) {
			h := newHost(t)
			h.ok("hello", `"protocol":1`)
			reply := h.send("define-capability", fmt.Sprintf(`"name":"api","ops":[{"name":"read","mode":"immediate","cost":{"fuel":0},%s}]`, fields))
			if _, ok := reply["ok"]; ok {
				t.Fatalf("accepted invalid documentation: %s", show(reply))
			}
		})
	}
	for _, fields := range []string{`"description":"","examples":[]`, `"description":"plain *text*","examples":["not parsed as NorthTalk",""]`} {
		h := newHost(t)
		h.ok("hello", `"protocol":1`)
		h.ok("define-capability", fmt.Sprintf(`"name":"api","ops":[{"name":"read","mode":"immediate","cost":{"fuel":0},%s}]`, fields))
	}
}
