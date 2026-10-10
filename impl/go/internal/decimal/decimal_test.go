package decimal

import (
	"math"
	"strings"
	"testing"
)

func number(t *testing.T, s string) Number {
	t.Helper()
	n, e := Parse(s)
	if e != nil {
		t.Fatal(e)
	}
	return n
}
func TestReadingNumbers(t *testing.T) {
	for _, tt := range []struct{ in, want string }{{"007", "7"}, {" 2.50 ", "2.50"}, {"-0.00", "0.00"}, {"-0xFF", "-255"}, {"0xabcdef", "11259375"}, {"\u20032.50\u2003", "2.50"}} {
		n, e := Parse(tt.in)
		if e != nil || n.String() != tt.want {
			t.Errorf("%q: %s %v", tt.in, n.String(), e)
		}
	}
	for _, s := range []string{"+1", "1e3", ".5", "1.", "5 kg", "NaN", "0XFF", "10000000000000000000000000000000000", "1.0000000000000000000000000000000000", "0." + strings.Repeat("0", 6176) + "1"} {
		if _, e := Parse(s); e == nil {
			t.Errorf("accepted %q", s)
		}
	}
	n := number(t, "0."+strings.Repeat("0", 6175)+"1")
	if n.Exponent() != -6176 {
		t.Fatal("smallest exponent")
	}
}
func TestArithmeticSpecExamples(t *testing.T) {
	for _, tt := range []struct{ a, op, b, want string }{
		{"0.1", "+", "0.2", "0.3"}, {"2.50", "*", "3", "7.50"}, {"10", "/", "4", "2.5"}, {"7.50", "/", "3", "2.50"}, {"1", "/", "0.01", "100"},
		{"1", "/", "3", "0.3333333333333333333333333333333333"}, {"2", "/", "3", "0.6666666666666666666666666666666667"},
		{"2", "^", "10", "1024"}, {"2.50", "^", "2", "6.2500"}, {"2", "^", "-3", "0.125"}, {"-7", "mod", "3", "-1"}, {"7.5", "mod", "2", "1.5"}, {"-7.5", "div", "2", "-3"},
		{"1.00", "-", "1", "0.00"}, {"9999999999999999999999999999999999", "+", "0.5", "overflow"},
		{"1.000000000000000000000000000000002", "+", "0.0000000000000000000000000000000005", "1.000000000000000000000000000000002"},
		{"1.000000000000000000000000000000003", "+", "0.0000000000000000000000000000000005", "1.000000000000000000000000000000004"},
	} {
		t.Run(tt.a+tt.op+tt.b, func(t *testing.T) {
			got, e := Calculate(tt.op, number(t, tt.a), number(t, tt.b))
			if tt.want == "overflow" {
				if e == nil || e.Code != "overflow" || e.Operator != tt.op {
					t.Fatalf("%v", e)
				}
				return
			}
			if e != nil || got.String() != tt.want {
				t.Fatalf("got %s %v; want %s", got.String(), e, tt.want)
			}
		})
	}
	for _, op := range []string{"/", "div", "mod", "^"} {
		b := "0"
		if op == "^" {
			b = "-1"
		}
		_, e := Calculate(op, number(t, "0"), number(t, b))
		if e == nil || e.Code != "division by zero" {
			t.Errorf("%s: %v", op, e)
		}
	}
}
func TestUnderflowIsRoundedOnce(t *testing.T) {
	for _, tt := range []struct{ digit, div, want string }{{"1", "2", "0"}, {"3", "2", "2"}, {"5", "2", "2"}, {"251", "100", "3"}} {
		a := number(t, "0."+strings.Repeat("0", 6176-len(tt.digit))+tt.digit)
		got, e := Calculate("/", a, number(t, tt.div))
		if e != nil {
			t.Fatal(e)
		}
		want := "0." + strings.Repeat("0", 6176-len(tt.want)) + tt.want
		if got.String() != want {
			t.Fatal("incorrect subnormal rounding")
		}
	}
}
func TestHostConversions(t *testing.T) {
	for _, f := range []float64{0.1, 1e-7, 1e20, math.SmallestNonzeroFloat64, math.Copysign(0, -1)} {
		n, e := FromFloat(f)
		if e != nil || n.Float64() != f {
			t.Errorf("%g: %s %v", f, n.String(), e)
		}
	}
	for _, f := range []float64{math.NaN(), math.Inf(1), math.Inf(-1), 1e34} {
		if _, e := FromFloat(f); e == nil {
			t.Errorf("accepted %g", f)
		}
	}
	for _, s := range []string{"9223372036854775807", "-9223372036854775808", "3.0"} {
		if _, e := number(t, s).Int64(); e != nil {
			t.Fatal(e)
		}
	}
	for _, s := range []string{"9223372036854775808", "1.1"} {
		if _, e := number(t, s).Int64(); e == nil {
			t.Fatal("accepted", s)
		}
	}
	if n, e := number(t, "18446744073709551615").Uint64(); e != nil || n != math.MaxUint64 {
		t.Fatal(n, e)
	}
	if _, e := number(t, "-1").Uint64(); e == nil {
		t.Fatal("negative uint")
	}
}

func TestPowerDomainsAndLargeExponents(t *testing.T) {
	for _, tt := range []struct{ a, b, want string }{
		{"0.00", "2", "0.0000"}, {"1.00", "1000000000000000000000000000000000", "1.000000000000000000000000000000000"},
		{"-1", "1000000000000000000000000000000001", "-1"}, {"0.5", "1000000000000000000000000000000000", "0." + strings.Repeat("0", 6176)},
		{"4", "0.5", "2"}, {"9", "0.5", "3"}, {"2", "0.5", "1.414213562373095048801688724209698"}, {"2", "1.5", "2.828427124746190097603377448419396"},
		{"0", "0.5", "0"}, {"4", "-0.5", "0.5"},
	} {
		n, e := Calculate("^", number(t, tt.a), number(t, tt.b))
		if e != nil || n.String() != tt.want {
			t.Errorf("%s ^ %s: %s %v, want %s", tt.a, tt.b, n.String(), e, tt.want)
		}
	}
	for _, tt := range []struct{ a, b, code string }{{"-2", "0.5", "out of domain"}, {"0", "-0.5", "division by zero"}, {"2", "1000000000000000000000000000000000", "overflow"}} {
		_, e := Calculate("^", number(t, tt.a), number(t, tt.b))
		if e == nil || e.Code != tt.code {
			t.Errorf("%s ^ %s: %v", tt.a, tt.b, e)
		}
	}
}

func TestConversionTrimsWholeWhitespaceCharacters(t *testing.T) {
	for _, s := range []string{" \u03011 \u0301", "\u2003\u03012.50\u2003\u0301"} {
		n, e := Parse(s)
		if e != nil {
			t.Fatal(e)
		}
		want := "1"
		if strings.Contains(s, "2.50") {
			want = "2.50"
		}
		if n.String() != want {
			t.Fatal(n.String(), want)
		}
	}
}
func TestJSONNumberDigits(t *testing.T) {
	nines := strings.Repeat("9", Precision)
	for _, s := range []string{nines, "-" + nines, "0." + strings.Repeat("0", 100) + "1", "1." + strings.Repeat("0", Precision-1), "0." + nines, "0.00" + nines + "e2"} {
		if _, e := ParseJSON(s); e != nil {
			t.Errorf("rejected %q: %v", s, e)
		}
	}
	// Refused by counting digits, before any big.Int conversion (#608).
	for _, s := range []string{nines + "9", "1." + strings.Repeat("0", Precision), strings.Repeat("9", 1_000_000), "-" + strings.Repeat("9", 1_000_000) + "e-999"} {
		if _, e := ParseJSON(s); e == nil {
			t.Errorf("accepted %.40q", s)
		}
	}
}
