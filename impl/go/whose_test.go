package northtalk

import (
	"context"
	"strconv"
	"strings"
	"testing"
	"time"
)

// A Whose Clause walks the chunks of its source and keeps those where its
// condition holds: every one, or the n-th or last match (ADR 0074).
func TestWhoseClausesPickChunks(t *testing.T) {
	for _, tc := range []struct{ expression, want string }{
		{"every item of [{amount: 5, paid: true}, {amount: 50, paid: false}, {amount: 70, paid: true}] whose amount > 10 and it's paid", "[{amount: 70, paid: true}]"},
		{`every word of "apple banana avocado cherry" whose it begins with "a"`, `["apple", "avocado"]`},
		{`every item of "a;;b" delimited by ";" whose it is not empty`, `["a", "b"]`},
		{"every item of [1, 2] whose it > 5", "[]"},
		{"the first item of [1, 2] whose it > 5", "nothing"},
		{"the second item of [3, 8, 1, 12, 9] whose it > 5", "12"},
		{"the last item of [3, 8, 1, 12, 9] whose it > 5", "9"},
		{"every item of [[1, 5], [2]] whose (every item of it whose it > 4) is not empty", "[[1, 5]]"},
		// The first match stops the walk before `8 / 0`.
		{"the first item of [4, 2, 0] whose 8 / it > 1", "4"},
	} {
		value, failure := runWhose(t, tc.expression)
		if failure != nil {
			t.Errorf("%s: %v", tc.expression, failure.Data)
		} else if value.String() != tc.want {
			t.Errorf("%s = %s; want %s", tc.expression, value, tc.want)
		}
	}
}

// `last` tests every chunk, and a condition must give a boolean, which is
// tested at `whose`.
func TestWhoseClauseFailures(t *testing.T) {
	for _, tc := range []struct{ expression, code, expected string }{
		{"the last item of [4, 2, 0] whose 8 / it > 1", "division by zero", ""},
		{"every item of [1, 2] whose it", "wrong kind", `"boolean"`},
	} {
		_, failure := runWhose(t, tc.expression)
		if failure == nil {
			t.Errorf("%s: no failure", tc.expression)
			continue
		}
		e := failure.Data.Get("error")
		if e.Get("code").String() != `"`+tc.code+`"` || tc.expected != "" && e.Get("expected").String() != tc.expected {
			t.Errorf("%s: %v", tc.expression, e)
		}
		if whose := strconv.Itoa(len(" return ") + strings.Index(tc.expression, "whose") + 1); tc.expected != "" && e.Get("at").Get("column").String() != whose {
			t.Errorf("%s: at %v; want column %s", tc.expression, e.Get("at"), whose)
		}
	}
}

func runWhose(t *testing.T, expression string) (Value, *ScriptError) {
	t.Helper()
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: "on go\n return " + expression + "\nend go\n"})
	if err != nil {
		t.Fatal(err)
	}
	_, p, err := s.Request(context.Background(), Message{Name: "go"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := g.Pump(time.Unix(0, 0), PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	return p.Result()
}
