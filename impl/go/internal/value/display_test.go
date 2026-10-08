package value

import (
	"github.com/odogono/odgn-talk/impl/go/internal/decimal"
	"strings"
	"testing"
)

func TestDisplayRoundTrips(t *testing.T) {
	for _, s := range []string{`nothing`, `true`, `2.50`, `"a" & newline & quote & fromCodePoint(8206)`, `"C:\new"`, `{if: true, "" & quote: 1, "unit price": 2.50 GBP}`, `<<0x0D, 0x0A>>`, `[1, "a", [nothing]]`, `3 m/s..7 m/s`, `2026-09-27T14:30:00.5`, `1969-12-31T23:59:59.999999999Z`, `<"ID-", 4 digits>`, `< <4 digits>, "x">`, `<last: word, ", ", first: word>`} {
		v, e := ParseDisplay(s, nil)
		if e != nil {
			t.Fatal(s, e)
		}
		again, e := ParseDisplay(v.Display(), nil)
		if e != nil || !again.Equal(v) || again.Display() != v.Display() {
			t.Fatal(s, again.Display(), e)
		}
	}
}
func TestMapDisplayQuotesOffer(t *testing.T) {
	const display = `{"offer": 1, if: true}`
	v, err := ParseDisplay(display, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := v.Display(); got != display {
		t.Fatalf("got %s, want %s", got, display)
	}
	again, err := ParseDisplay(v.Display(), nil)
	if err != nil || !again.Equal(v) || again.Display() != display {
		t.Fatal("map display round trip", again.Display(), err)
	}
}

func TestPatternsReparseAndCanonicalize(t *testing.T) {
	for _, tt := range []struct{ s, want string }{{`< "ID" , "-" , <0x04 digits> >`, `<"ID", "-", <4 digits>>`}, {`<4 digits lazily ignoring case as number>`, `<4 digits as number ignoring case lazily>`}, {`< <>, "x">`, `<"x">`}, {`<(quote & "x")>`, `<(quote & "x")>`}} {
		v, e := ParsePattern(tt.s)
		if e != nil || v.Display() != tt.want {
			t.Fatal(tt.s, v.Display(), e)
		}
	}
	for _, s := range []string{`<bogus>`, `<end: word>`, `<a civil date>`, `<x: digit, x: digit>`, `<optional x: digit>`, `<letter as number>`, `<"abc" as number>`, `<4.5 digits>`, `<digit ignoring case ignoring case>`, `<(arbitrary())>`} {
		if _, e := ParsePattern(s); e == nil {
			t.Errorf("accepted %s", s)
		}
	}
}
func TestOrderingRules(t *testing.T) {
	read := func(s string) Value {
		v, e := ParseDisplay(s, nil)
		if e != nil {
			t.Fatal(e)
		}
		return v
	}
	for _, p := range [][2]string{{`[1, "b"]`, `[2, "a"]`}, {`[1, 2]`, `[1, 2, 0]`}, {`"Zebra"`, `"apple"`}, {`<<0x7F>>`, `<<0xFF>>`}, {`1 L`, `2 m^3`}, {`2026-01-01`, `2026-01-02`}} {
		c, e := read(p[0]).Compare(read(p[1]))
		if e != nil || c >= 0 {
			t.Fatal(p, c, e)
		}
	}
	for _, p := range [][2]string{{`nothing`, `nothing`}, {`true`, `false`}, {`{a: 1}`, `{a: 1}`}, {`1`, `"1"`}, {`1 month`, `1 day`}, {`[1, "a"]`, `[1, 2]`}, {`2026-01-01`, `2026-01-01T00:00:00`}} {
		if _, e := read(p[0]).Compare(read(p[1])); e == nil {
			t.Fatal("ordered", p)
		}
	}
}
func TestUnitsFollowLexicalRules(t *testing.T) {
	for _, p := range []struct{ in, want string }{{"s*kg*m/s", "kg*m"}, {"m*m", "m^2"}, {"days", "day"}, {"m^2/m", "m"}, {"1/s^2", "1/s^2"}} {
		u, e := ParseUnit(p.in)
		if e != nil || u.String() != p.want {
			t.Fatal(p, u.String(), e)
		}
	}
	for _, s := range []string{"m*ft", "year/month", "month^1", "month*month/month", "s//m", "s^0", "s^01", "s^-1", "1", "h", "m/", "m**s"} {
		if _, e := ParseUnit(s); e == nil {
			t.Errorf("accepted %s", s)
		}
	}
	n, _ := decimal.Parse("9")
	u, _ := ParseUnit("degF")
	n, e := u.Convert(n, true)
	if e != nil || n.String() != "5" {
		t.Fatal(n, e)
	}
}

func TestPatternLiteralAmpersandStaysQuoted(t *testing.T) {
	v, e := ParsePattern(`<"a & b">`)
	if e != nil || v.Display() != `<"a & b">` {
		t.Fatal(v.Display(), e)
	}
	if _, e := ParsePattern(`<"a" & "b">`); e == nil {
		t.Fatal("unparenthesized expression in pattern")
	}
}

func TestUnitConversionUsesSpecFactorOrder(t *testing.T) {
	u, _ := ParseUnit("degF")
	n, _ := decimal.Parse("3000000000000000000000000000000000")
	if _, e := u.Convert(n, false); e == nil {
		t.Fatal("denominator multiplication must overflow before numerator division")
	}
	a, _ := NewQuantity(decimal.FromInt(1), "min^2147483647")
	b, _ := NewQuantity(decimal.FromInt(1), "hr^2147483647")
	if c, e := a.Compare(b); e != nil || c >= 0 || a.Equal(b) {
		t.Fatal("large non-identity powers", c, e)
	}
}

func TestQuantityComparisonRoundsSubnormalBases(t *testing.T) {
	n, _ := decimal.Parse("0." + strings.Repeat("0", 6175) + "1")
	a, _ := NewQuantity(n, "g")
	zero, _ := NewQuantity(decimal.FromInt(0), "kg")
	negative, _ := NewQuantity(n.Negate(), "g")
	if !a.Equal(zero) || !a.Equal(negative) {
		t.Fatal("subnormal Base Unit magnitude must round to zero")
	}
	if c, e := a.Compare(zero); c != 0 || e != nil {
		t.Fatal(c, e)
	}
}

func TestUnitPowersHaveNoMachineIntegerLimit(t *testing.T) {
	power := "10000000000000000000000000000000000000000"
	a, e := NewQuantity(decimal.FromInt(1), "min^"+power)
	if e != nil {
		t.Fatal(e)
	}
	b, e := NewQuantity(decimal.FromInt(1), "hr^"+power)
	if e != nil {
		t.Fatal(e)
	}
	if c, e := a.Compare(b); e != nil || c >= 0 {
		t.Fatal("arbitrary-size Unit powers", c, e)
	}
	huge, _ := NewQuantity(decimal.FromInt(1), "km^"+power)
	twice, _ := NewQuantity(decimal.FromInt(2), "km^"+power)
	if !huge.Equal(huge) || huge.Equal(twice) {
		t.Fatal("arbitrary-size decimal exponent comparison")
	}
	v, e := ParseDisplay(a.Display(), nil)
	if e != nil || v.Display() != a.Display() {
		t.Fatal("Unit power round trip", e)
	}
}

func TestLargeQuantityComparisonSignsAndRoundedMerging(t *testing.T) {
	u := "min^2147483647"
	positive, _ := NewQuantity(decimal.FromInt(1), u)
	negative, _ := NewQuantity(decimal.FromInt(-1), u)
	zero, _ := NewQuantity(decimal.FromInt(0), u)
	for _, pair := range [][2]Value{{negative, zero}, {zero, positive}, {negative, positive}} {
		if c, e := pair[0].Compare(pair[1]); e != nil || c >= 0 {
			t.Fatal("large Unit powers must preserve normal signs", c, e)
		}
	}
	n, _ := decimal.Parse("1.000000000000000000000000000000001")
	near, _ := NewQuantity(n, u)
	// Sequential 34-digit conversion merges these coefficients after 63
	// multiplications. Comparing their original coefficients would be wrong.
	if !positive.Equal(near) {
		t.Fatal("rounded Base Unit conversion must retain merging")
	}
}

func TestDisplayRejectsMalformedCanonicalNumbersDatesAndFunctions(t *testing.T) {
	for _, s := range []string{`007`, `-0.00`, `2026-09-27T14:30:00.500`, `<function s:12::>`, `<function s:0:1>`} {
		if _, e := ParseDisplay(s, nil); e == nil {
			t.Errorf("accepted %s", s)
		}
	}
}
