package northtalk

import (
	"context"
	"testing"
	"time"
)

// Chapter 8 counts copies of the singular class, and zero copies emit no code.
// The trailing match instruction is included in the Script's PatternSize.
func TestPatternLiteralSizeCountsNormativeProgram(t *testing.T) {
	for _, tc := range []struct {
		source string
		size   int
	}{
		{`<0 words>`, 1},
		{`<3 uppercase letters>`, 4},
		{`<3 lowercase letters>`, 4},
		{`<2 words>`, 7},
		{`<a number>`, 9},
	} {
		t.Run(tc.source, func(t *testing.T) {
			for _, limit := range []int{tc.size, tc.size - 1} {
				if limit == 0 {
					continue // zero selects the default limit in the embedding API
				}
				g := New().NewGroup(GroupOptions{})
				_, err := g.Load(LoadOptions{Name: "pattern", Source: "on go\n return " + tc.source + "\nend go\n", Limits: Limits{PatternSize: limit}})
				if limit == tc.size {
					if err != nil {
						t.Fatalf("program of size %d rejected at its limit: %v", tc.size, err)
					}
				} else {
					rejected, ok := err.(*LoadError)
					if !ok || len(rejected.Diagnostics) != 1 || rejected.Diagnostics[0].Code != "pattern too large" {
						t.Fatalf("expected pattern too large at %d: %v", limit, err)
					}
				}
			}
		})
	}
}

func TestPatternCompositionReportsWrongKind(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "pattern", Source: "on go\n return <(42)>\nend go\n"})
	if err != nil {
		t.Fatal(err)
	}
	_, pending, err := s.Request(context.Background(), Message{Name: "go"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := g.Pump(time.Date(2026, 9, 30, 9, 0, 0, 0, time.UTC), PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	_, scriptErr := pending.Result()
	if scriptErr == nil || scriptErr.Code != "send failed" {
		t.Fatalf("expected failed Request: %+v", scriptErr)
	}
	raised := scriptErr.Data.Get("error")
	if raised.Get("code").String() != `"wrong kind"` || raised.Get("expected").String() != `"pattern"` || !raised.Get("value").Equal(Int(42)) {
		t.Fatalf("wrong splice error: %+v", scriptErr)
	}
}

func TestPatternCompositionCapturesAndCanonicalSource(t *testing.T) {
	for _, tc := range []struct{ body, want string }{
		{`put <n: digits as number> into p
 return every match of <"$", (p)> in "$0042"`, `[{text: "$0042", range: 1..5, captures: {n: 42}, ranges: {n: 2..5}}]`},
		{`return every match of < <n: digit> or ""> in "a"`, `[{text: "", range: 1..0, captures: {n: nothing}, ranges: {n: nothing}}, {text: "", range: 2..1, captures: {n: nothing}, ranges: {n: nothing}}]`},
		{`put quote & newline & "(2)" into a
 put "x" into b
 return (a & b) matches <(a), (b)>`, `true`},
		{`put <"A", uppercase letter> into p
 return ["aB" matches <(p)> ignoring case, "ab" matches <(p)> ignoring case]`, `[true, false]`},
		{`put <n: digit> into p
 try
  return <(p), (p)>
 catch e
  return [the code of e, the to of e]
 end try`, `["can't convert", "pattern"]`},
		{`put <n: digit> into p
 try
  return <optional (p)>
 catch e
  return [the code of e, the to of e]
 end try`, `["can't convert", "pattern"]`},
		{`put <0x04 digits> into p
 put <(p), "x"> into composed
 return [composed, composed = < <4 digits>, "x">]`, `[< <4 digits>, "x">, true]`},
		{`put <> into p
 return <(p), "x">`, `<"x">`},
	} {
		t.Run(tc.want, func(t *testing.T) {
			g := New().NewGroup(GroupOptions{})
			s, err := g.Load(LoadOptions{Name: "pattern", Source: "on go\n " + tc.body + "\nend go\n"})
			if err != nil {
				t.Fatal(err)
			}
			_, pending, err := s.Request(context.Background(), Message{Name: "go"})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := g.Pump(time.Date(2026, 9, 30, 9, 0, 0, 0, time.UTC), PumpOptions{}); err != nil {
				t.Fatal(err)
			}
			v, scriptErr := pending.Result()
			if scriptErr != nil || v.String() != tc.want {
				t.Fatalf("got %s (%v), want %s", v.String(), scriptErr, tc.want)
			}
		})
	}
}

func TestPatternCompositionCostModelZero(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "pattern", Source: "on go needle\n return <(needle)>\nend go\n"})
	if err != nil {
		t.Fatal(err)
	}
	needle, err := Text("0042")
	if err != nil {
		t.Fatal(err)
	}
	_, pending, err := s.Request(context.Background(), Message{Name: "go", Args: []Value{needle}})
	if err != nil {
		t.Fatal(err)
	}
	report, err := g.Pump(time.Date(2026, 9, 30, 9, 0, 0, 0, time.UTC), PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	v, scriptErr := pending.Result()
	if scriptErr != nil || v.String() != `<"0042">` {
		t.Fatalf("%s %v", v.String(), scriptErr)
	}
	// clause 4 + load 1 + make-pattern (20 + 2 * program 5) + return 2.
	// The result allocates 16 + 8 * program 5 bytes, with no other allocation.
	if len(operationalReports(report.Reports)) != 1 {
		t.Fatalf("unexpected reports: %+v", report)
	}
	end, ok := operationalReports(report.Reports)[0].(*RunEnd)
	if !ok || report.FuelUsed != 37 || end.Alloc != 56 {
		t.Fatalf("unexpected compilation charge: %+v", report)
	}
}
