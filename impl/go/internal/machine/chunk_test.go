package machine

import "testing"

func TestItemsProperty(t *testing.T) {
	for _, tc := range []struct{ expr, want string }{
		{`the items of [1, 2]`, `[1, 2]`},
		{`the items of []`, `[]`},
		{`the items of [nothing, {amount: 2}, [3]]`, `[nothing, {amount: 2}, [3]]`},
		{`the items of [1, 2] delimited by ";"`, `[1, 2]`},
		{`the items of "a, b"`, `["a", " b"]`},
		{`the items of "a;b" delimited by ";"`, `["a", "b"]`},
		{`the items of (2..4)`, `[2, 3, 4]`},
	} {
		t.Run(tc.expr, func(t *testing.T) {
			r := executeSource(t, "on go\n return "+tc.expr+"\nend go\n")
			if r.Status != Completed || r.Result.Display() != tc.want {
				t.Fatalf("status=%v result=%s error=%s; want %s", r.Status, r.Result.Display(), r.Error.Display(), tc.want)
			}
		})
	}
}

func TestItemsPropertyWrongKind(t *testing.T) {
	for _, tc := range []struct{ expr, kind, want string }{
		{`42`, "number", `42`},
		{`true`, "boolean", `true`},
		{`nothing`, "nothing", `nothing`},
		{`{a: 1}`, "map", `{a: 1}`},
		{`<<1, 2>>`, "bytes", `<<0x01, 0x02>>`},
		{`(1.5..3.5)`, "range", `1.5..3.5`},
	} {
		t.Run(tc.expr, func(t *testing.T) {
			r := executeSource(t, "on go\n return the items of "+tc.expr+"\nend go\n")
			if r.Status != Errored || r.Error.Get("code").Text != "wrong kind" || r.Error.Get("expected").Text != "list" || r.Error.Get("got").Text != tc.kind || r.Error.Get("value").Display() != tc.want {
				t.Fatalf("status=%v error=%s; want wrong kind, expected list, got %s, value %s", r.Status, r.Error.Display(), tc.kind, tc.want)
			}
		})
	}
}
