package decimal

import (
	"math/big"
	"math/rand/v2"
	"strconv"
	"testing"
)

// Compare the optimized path and its overflow fallbacks with exact rational
// arithmetic, including the stored quantum rather than just numeric equality.
func TestSmallArithmeticAgainstRationals(t *testing.T) {
	values := []Number{{}}
	for _, s := range []string{
		"0.00", "1", "-1", "2.50", "-0.125",
		"9223372036854775807", "-9223372036854775808",
		"9223372036854775808", "-9223372036854775809",
		"9999999999999999999999999999999999",
		"0.0000000000000000001",
	} {
		values = append(values, number(t, s))
	}
	values = append(values, Number{coefficient: "1", exponent: MinExponent}, Number{coefficient: "5", exponent: MinExponent})
	rng := rand.New(rand.NewPCG(322, 1))
	for range 50 {
		values = append(values, Number{coefficient: strconv.FormatInt(int64(rng.Uint64()), 10), exponent: -rng.IntN(19)})
	}
	for _, a := range values {
		for _, b := range values {
			for _, op := range []string{"+", "-", "*"} {
				x, y := a.Rat(), b.Rat()
				ideal := min(a.exponent, b.exponent)
				switch op {
				case "+":
					x.Add(x, y)
				case "-":
					x.Sub(x, y)
				case "*":
					x.Mul(x, y)
					ideal = a.exponent + b.exponent
				}
				want, we := Round(x, ideal, op)
				got, ge := Calculate(op, a, b)
				if (we == nil) != (ge == nil) || we != nil && *we != *ge || we == nil && got != want {
					t.Fatalf("%s %s %s: got %+v / %v; want %+v / %v", a.Snapshot(), op, b.Snapshot(), got, ge, want, we)
				}
			}
			want := a.Rat().Cmp(b.Rat())
			if got := a.Compare(b); got != want {
				t.Fatalf("compare %s and %s: got %d; want %d", a.Snapshot(), b.Snapshot(), got, want)
			}
		}
	}
}

func TestSmallComparisonRespectsExtendedExponents(t *testing.T) {
	a := FromInt(1).withComparisonExp(new(big.Int).Lsh(big.NewInt(1), 70))
	if a.Compare(FromInt(1)) != 1 || FromInt(1).Compare(a) != -1 {
		t.Fatal("extended exponent was ignored")
	}
}
