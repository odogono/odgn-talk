package machine

import (
	"fmt"
	"github.com/odogono/odgn-talk/impl/go/internal/value"
	"strings"
	"testing"
)

func TestTypesConversionsMembershipAndMapWrites(t *testing.T) {
	cases := []struct{ body, want string }{
		{`return ["42" is a number, 3.0 is an integer, nothing is empty, [] is empty, "42" can be a number, "lots" can be a number]`, `[false, true, false, true, true, false]`},
		{`return [" 2.50 " as number, "5 kg" as g, "2026-01-31" as civil date]`, `[2.50, 5000 g, 2026-01-31]`},
		{`return [2 is in [1, 2, 3], "a" is in {a: 1}, 2 is in 1..3, 1 is in 3..1]`, `[true, true, true, false]`},
		{"put {a: 1, b: 2} into m\n put 3 into the a of m\n put \"c\" into k\n put 4 into the (k) of m\n delete the b of m\n delete the (k) of m\n return m", `{a: 3}`},
		{"put [1, 2] into xs\n put 9 into item 4 of xs\n return xs", `[1, 2, nothing, 9]`},
		{`return [the length of (5..7), the items of (5..7), item 2 of (5..7)]`, `[3, [5, 6, 7], 6]`},
		{`return ["A", {name: "B"}] = ["a", {name: "b"}] ignoring case`, `true`},
		{"put <<1, 2, 3>> into b\n put 255 into byte 2 of b\n delete byte 1 of b\n return b", `<<0xFF, 0x03>>`},
	}
	for _, tc := range cases {
		t.Run(tc.want, func(t *testing.T) {
			r := executeSource(t, "on go\n "+tc.body+"\nend go\n")
			if r.Status != Completed || r.Result.Display() != tc.want {
				t.Fatalf("status=%v at=%s result=%s error=%s", r.Status, r.At.Name, r.Result.Display(), r.Error.Display())
			}
		})
	}
}
func TestQuantityAndDateArithmetic(t *testing.T) {
	for _, tc := range []struct{ expr, want string }{
		{"5 kg + 250 g", "5.250 kg"}, {"4 yd / 2 ft", "6"}, {"2 m * 3 ft", "1.8288 m^2"}, {"1 / 2 s", "0.5 1/s"}, {"(2 m) ^ 2", "4 m^2"},
		{`("2026-01-31" as civil date) + 1 month`, `2026-02-28`},
		{`("2026-01-31T12:00:00Z" as instant) + 90 s`, `2026-01-31T12:01:30Z`},
		{`("2026-02-02" as civil date) - ("2026-01-31" as civil date)`, `2 days`},
	} {
		t.Run(tc.expr, func(t *testing.T) {
			r := executeSource(t, "on go\n return "+tc.expr+"\nend go\n")
			if r.Status != Completed || r.Result.Display() != tc.want {
				t.Fatalf("status=%v at=%s result=%s error=%s", r.Status, r.At.Name, r.Result.Display(), r.Error.Display())
			}
		})
	}
}
func TestBinaryBuildAndDestructure(t *testing.T) {
	r := executeSource(t, "on go\n put <<2, 7 as uint32, -3 as int16 little, 10 as 4 bits, 5 as 4 bits, \"ok\" as 2 bytes as text>> into packet\n let <<2, id: uint32, x: int16 little, a: 4 bits, b: 4 bits, body: 2 bytes as text>> be packet\n return [id, x, a, b, body]\nend go\n")
	if r.Status != Completed || r.Result.Display() != `[7, -3, 10, 5, "ok"]` {
		t.Fatalf("status=%v at=%s result=%s error=%s", r.Status, r.At.Name, r.Result.Display(), r.Error.Display())
	}
}
func TestFunctionValuesAndPatternReplacement(t *testing.T) {
	for _, tc := range []struct{ source, want string }{
		{"function plus x, y = 2\n return x + y\nend plus\non go\n put plus into f\n return [f(3), functionArity(f), functionName(f)]\nend go\n", `[5, 1..2, "plus"]`},
		{"on go\n put 5 into n\n put given x: x + n into f\n put 9 into n\n return [f(3), functionName(f)]\nend go\n", `[8, nothing]`},
		{"on go\n let <\"ID-\", n: digits as number> be \"ID-0042\"\n return n\nend go\n", `42`},
		{"on go\n return replace <zero or more of \"-\"> in \"a-b\" with \"+\"\nend go\n", `"+a+b+"`},
		{"on go\n return replace <last: word, \", \", first: word> in \"Smith, Ann\" with first & \" \" & last\nend go\n", `"Ann Smith"`},
	} {
		t.Run(tc.want, func(t *testing.T) {
			r := executeSource(t, tc.source)
			if r.Status != Completed || r.Result.Display() != tc.want {
				t.Fatalf("status=%v at=%s result=%s error=%s", r.Status, r.At.Name, r.Result.Display(), r.Error.Display())
			}
		})
	}
}
func TestStandaloneBuiltins(t *testing.T) {
	for _, tc := range []struct{ expr, want string }{
		{`[floor(-2.5), ceiling(-2.5), truncate(-2.5), round(2.5), round(-2.5), round(2.5, 0, "half even"), round(3, 2), round(2.567 kg, 2)]`, `[-3, -2, -2, 3, -3, 2, 3.00, 2.57 kg]`},
		{`[sqrt(4), exp(0), ln(1), log10(1000), power(2.50, 2), sin(0), cos(0), tan(0), asin(0), acos(1), atan(0)]`, `[2, 1, 0, 3, 6.2500, 0, 1, 0, 0, 0, 0]`},
		{`[sqrt(2), exp(1), ln(2), sin(1), cos(1), atan(1)]`, `[1.414213562373095048801688724209698, 2.718281828459045235360287471352662, 0.6931471805599453094172321214581766, 0.841470984807896506652502321630299, 0.5403023058681397174009366074429766, 0.7853981633974483096156608458198757]`},
		{`[upper("Straße"), lower("ΟΔΟΣ"), lower("AΣ AΣA")]`, `["STRASSE", "οδος", "aς aσa"]`},
		{`[fromFloat32(<<0x3D, 0xCC, 0xCC, 0xCD>>), toFloat64(1.5, "little")]`, `[0.1, <<0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xF8, 0x3F>>]`},
		{`[year("2026-10-03" as civil date), weekday("2026-10-03" as civil date), dayOfYear("2026-10-03" as civil date), hasTime("2026-10-03" as civil date)]`, `[2026, 6, 276, false]`},
		{`[toCivil("2026-01-31T12:00:00Z" as instant, 90 min), toInstant("2026-01-31T13:30:00" as civil date, 90 min)]`, `[2026-01-31T13:30:00, 2026-01-31T12:00:00Z]`},
	} {
		t.Run(tc.want, func(t *testing.T) {
			r := executeSource(t, "on go\n return "+tc.expr+"\nend go\n")
			if r.Status != Completed || r.Result.Display() != tc.want {
				t.Fatalf("status=%v at=%s result=%s error=%s", r.Status, r.At.Name, r.Result.Display(), r.Error.Display())
			}
		})
	}
}

func TestConstructionLimitsBeforeMaterialization(t *testing.T) {
	for _, body := range []string{
		"return the items of (1..9223372036854775807)",
		"return item 9223372036854775806..9223372036854775807 of (1..9999999999999999999999999999999999)",
		"put [] into xs\n put 9 into item 9223372036854775807 of xs\n return xs",
	} {
		s, e := Initialize(compile(t, "on go\n "+body+"\nend go\n"))
		if e != nil {
			t.Fatal(e)
		}
		r := Start(s, 1, nil, Limits{Fuel: 100, Alloc: 1000})
		r.Execute(0)
		if r.Status != Faulted || r.Limit != "fuel" {
			t.Fatalf("%s: status=%v limit=%s", body, r.Status, r.Limit)
		}
	}
}

func TestLambdaDestructuringArityAndCatalogueErrors(t *testing.T) {
	for _, tc := range []struct{ body, want string }{
		{`put given [x, y]: x into f
 return functionArity(f)`, `1..1`},
		{`put given [x, y]: x into f
 try
  return f()
 catch "wrong arity"
  return true
 end try`, `true`},
		{`try
  return power(0, -1)
 catch {code: "division by zero", operator: x}
  return x
 catch "division by zero"
  return true
 end try`, `true`},
	} {
		r := executeSource(t, "on go\n "+tc.body+"\nend go\n")
		if r.Status != Completed || r.Result.Display() != tc.want {
			t.Fatalf("%s: status=%v result=%s", tc.body, r.Status, r.Result.Display())
		}
	}
}

func TestDeliveryTriesClausesAndSkipsGuardErrors(t *testing.T) {
	s, e := Initialize(compile(t, "on pick n where 1 / 0 = n\n return 1\nend pick\non pick 2\n return 20\nend pick\non pick n\n return n + 1\nend pick\n"))
	if e != nil {
		t.Fatal(e)
	}
	r := StartDelivery(s, "pick", []value.Value{integer(3)}, Limits{Fuel: 1000, Alloc: 1000}, false)
	r.Execute(0)
	if r.Status != Dispatching || r.Clause != 3 || !r.AcceptClause(false) {
		t.Fatalf("dispatch did not reach the selected body: %+v", r)
	}
	r.Execute(0)
	if r.Status != Completed || r.Result.Display() != "4" || r.Clause != 3 || len(r.Raises) != 1 || !r.Raises[0].Guard {
		t.Fatalf("%+v", r)
	}
}

func TestLocalHandlerCallsAndBytesSearch(t *testing.T) {
	for _, tc := range []struct{ source, want string }{
		{"on pick 2\n return 20\nend pick\non pick n\n return n + 1\nend pick\non go\n return pick(3)\nend go\n", "4"},
		{"on pick 2\n return 20\nend pick\non go\n try\n  return pick(3)\n catch \"no match\"\n  return true\n end try\nend go\n", "true"},
		{"on go\n return [<<13,10>> contains <<10>>, <<255,0>> begins with <<255>>, <<1,2>> ends with <<2>>]\nend go\n", "[true, true, true]"},
	} {
		r := executeSource(t, tc.source)
		if r.Status != Completed || r.Result.Display() != tc.want {
			t.Fatalf("status=%v at=%s result=%s error=%s", r.Status, r.At.Name, r.Result.Display(), r.Error.Display())
		}
	}
}

func TestDeleteChargesNoNewPartAndPowerDomainFields(t *testing.T) {
	r := executeSource(t, "on go\n put <<1,2,3>> into b\n delete byte 1 of b\n return b\nend go\n")
	baseline := executeSource(t, "on go\n put <<1,2,3>> into b\n return b\nend go\n")
	if r.Alloc != baseline.Alloc {
		t.Fatalf("delete allocation=%d", r.Alloc-baseline.Alloc)
	}
	r = executeSource(t, "on go\n return (-8)^0.5\nend go\n")
	if r.Error.Get("function").Text != "power" || r.Error.Get("value").Display() != "-8" {
		t.Fatal(r.Error.Display())
	}
}

func TestFoldedMapEqualityPreservesDistinctEntries(t *testing.T) {
	for _, body := range []string{
		`put {A: 1, a: 2} into m
 return m = m ignoring case`,
		`return {A: 1, a: 2} = {a: 2, A: 1} ignoring case`,
		`return {A: 1, a: 2} is in [{a: 2, A: 1}] ignoring case`,
	} {
		r := executeSource(t, "on go\n "+body+"\nend go\n")
		if r.Status != Completed || r.Result.Display() != "true" {
			t.Fatalf("%s: %s", body, r.Result.Display())
		}
	}
}

func TestDelimitedRangeBoundsAndOperandErrors(t *testing.T) {
	for _, tc := range []struct {
		body        string
		status      Status
		limit, code string
	}{
		{`return the items of (1..9223372036854775807) delimited by ","`, Faulted, "fuel", ""},
		{`return item 9223372036854775807 of (1..9223372036854775807) delimited by ","`, Faulted, "fuel", ""},

		{`return character 1000000 of (1..2000000)`, Errored, "", "wrong kind"},
		{`return the items of (1..9223372036854775807) delimited by ""`, Errored, "", "out of range"},
	} {
		t.Run(tc.body, func(t *testing.T) {
			s, e := Initialize(compile(t, "script variable xs = 1..9223372036854775807\non go\n "+tc.body+"\nend go\n"))
			if e != nil {
				t.Fatal(e)
			}
			r := Start(s, 1, nil, Limits{Fuel: 100, Alloc: 1000})
			r.Execute(0)
			if strings.HasPrefix(tc.body, "return item") {
				for _, i := range s.Unit.Bodies[1].Code {
					if i.Name == "chunk-get-delimited" {
						i.Name = "test-chunk-delimited"
						q := Start(s, 1, nil, Limits{Fuel: 100, Alloc: 1000})
						f := &Frame{Stack: []value.Value{integer(9223372036854775807), s.Variables[0], text(",")}}
						if q.preflight(f, i) || q.Status != Faulted {
							t.Fatal("delimited test-chunk escaped bound")
						}
					}
				}
			}
			if r.Status != tc.status || r.Limit != tc.limit || r.Error.Get("code").Text != tc.code {
				t.Fatalf("status=%v limit=%s error=%s", r.Status, r.Limit, r.Error.Display())
			}
		})
	}
	s, e := Initialize(compile(t, "on go\n return the items of (3..1)\nend go\n"))
	if e != nil {
		t.Fatal(e)
	}
	r := Start(s, 1, nil, Limits{Fuel: 100, Alloc: 64})
	r.Execute(0)
	if r.Status != Completed || r.Result.Display() != "[]" {
		t.Fatalf("payable empty list: %v %s", r.Status, r.Limit)
	}
}

func TestBytesPropertyRejectsUnaffordableConstructionBeforeEvaluation(t *testing.T) {
	s, err := Initialize(compile(t, "on go b\n return the bytes of b\nend go\n"))
	if err != nil {
		t.Fatal(err)
	}
	for _, limit := range []Limits{{Fuel: 100, Alloc: 1000000}, {Fuel: 1000000, Alloc: 100}, {Bounded: true, Fuel: 0, Alloc: 1000000}, {Bounded: true, Fuel: 1000000, Alloc: 0}} {
		r := Start(s, 1, []value.Value{{Kind: value.Bytes, Bytes: make([]byte, 4096)}}, limit)
		f := &r.Frames[0]
		f.Stack = []value.Value{{Kind: value.Bytes, Bytes: make([]byte, 4096)}}
		for _, i := range s.Unit.Bodies[1].Code {
			if i.Name == "property" && i.Operands()[0].Text == "bytes" {
				if r.preflight(f, i) || r.Status != Faulted || r.Fuel != 0 || r.Alloc != 0 {
					t.Fatalf("unpaid bound: %v fuel=%d alloc=%d", r.Status, r.Fuel, r.Alloc)
				}
			}
		}
	}
}

func TestFoldedMapComparisonChargesAllMatchedEntries(t *testing.T) {
	var left, right []value.Pair
	for n := 1; n <= 17; n++ {
		left = append(left, value.Pair{Key: fmt.Sprintf("A%d", n), Val: integer(int64(n))})
		right = append(right, value.Pair{Key: fmt.Sprintf("a%d", n), Val: integer(int64(n))})
	}
	a, _ := value.NewMap(left)
	b, _ := value.NewMap(right)
	if !equal(a, b, true) || compared(a, b, true) != 17 {
		t.Fatalf("equal=%v scanned=%d", equal(a, b, true), compared(a, b, true))
	}
}

func TestZeroFuelHostChargeIsRefusedBeforeFaulting(t *testing.T) {
	r := &Run{Limits: Limits{Bounded: true, Fuel: 0, Alloc: 100}}
	if r.ChargeHost(1) || r.Status == Faulted || r.Fuel != 0 {
		t.Fatalf("charge=%d status=%v", r.Fuel, r.Status)
	}
}
