package machine

import (
	"strings"
	"testing"
)

// The Display of `out` after `go` puts the expression into it, catching any
// error into `out` as its code and its Shape-check fields.
func shapeExpr(t *testing.T, expr string) string {
	t.Helper()
	unit := compile(t, "script variable out\non go\n try\n  put "+expr+" into out\n catch e\n  put e into out\n end try\nend go\n")
	s, e := Initialize(unit)
	if e != nil {
		t.Fatal(e)
	}
	r := Start(s, 1, nil, Limits{Fuel: 100000, Alloc: 1000000, Depth: 200})
	r.Execute(0)
	if r.Status != Completed {
		t.Fatalf("%s: status %v raises %v", expr, r.Status, r.Raises)
	}
	return s.Variables[0].Display()
}

func TestShapeCheckBuiltins(t *testing.T) {
	for _, tc := range []struct{ expr, want string }{
		{`conforms(3, "number")`, "true"},
		{`conforms("x", "number")`, "false"},
		{`conforms([given x: x], "any")`, "false"},
		{`conforms([given x: x], "value")`, "true"},
		{`conforms(5 cm, {quantity: "m"})`, "false"},
		{`conforms(5 m, {unitKind: "length"})`, "true"},
		{`conforms({}, {map: [{key: "a", shape: {optional: "text"}}]})`, "false"},
		{`conforms({}, {map: [{key: "a", shape: "text", optional: true}]})`, "true"},
		{`check({a: 1}, {map: [{key: "a", shape: "number"}]})`, "{a: 1}"},
		{`explain("x", "number")`, `[{code: "wrong kind", expected: "number", got: "text", value: "x"}]`},
		{`explain([1, "x", true], {list: "number"})`, `[{code: "wrong kind", expected: "number", got: "text", value: "x", path: [2]}, {code: "wrong kind", expected: "number", got: "boolean", value: true, path: [3]}]`},
		{`explain([given x: x], "any")`, `[{code: "not encodable", kind: "function", path: [1]}]`},
	} {
		if got := shapeExpr(t, tc.expr); got != tc.want {
			t.Errorf("%s: got %s, want %s", tc.expr, got, tc.want)
		}
	}
}

func TestShapeCheckBuiltinErrors(t *testing.T) {
	for _, tc := range []struct{ expr, code, field, want string }{
		{`check("x", "number")`, "wrong kind", "expected", "number"},
		{`check(3, {optional: "text"})`, "wrong kind", "expected", "text or nothing"},
		{`check([given x: x], "any")`, "not encodable", "kind", "function"},
		{`conforms(3, {oneOf: ["number", "bogus"]})`, "invalid shape", "reason", "unknown kind"},
		{`conforms(3, {oneOf: []})`, "invalid shape", "reason", "empty union"},
	} {
		got := shapeExpr(t, tc.expr)
		want := `code: "` + tc.code + `"`
		if !strings.Contains(got, want) || !strings.Contains(got, tc.field+`: "`+tc.want+`"`) {
			t.Errorf("%s: got %s, want %s with %s %q", tc.expr, got, tc.code, tc.field, tc.want)
		}
		if strings.Contains(got, "capability:") || strings.Contains(got, "argument:") {
			t.Errorf("%s: error carries Capability context: %s", tc.expr, got)
		}
	}
}
