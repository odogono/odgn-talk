package decimal

import (
	"math"
	"math/big"
	"strings"
	"testing"
)

func TestCoefficientCacheConstructionAndRestore(t *testing.T) {
	jsonNumber, err := ParseJSON("-1.250e2")
	if err != nil {
		t.Fatal(err)
	}
	floatNumber, err := FromFloat(0.125)
	if err != nil {
		t.Fatal(err)
	}
	values := []Number{{}, FromInt(math.MinInt64), FromInt(math.MaxInt64), FromUint(math.MaxUint64), jsonNumber, floatNumber}
	for _, s := range []string{"-0.00", "2.50", "-0xFF", "9223372036854775808", "-9223372036854775809", "9999999999999999999999999999999999", "0." + strings.Repeat("0", 6175) + "1"} {
		values = append(values, number(t, s))
	}
	for _, n := range values {
		text := n.coefficient
		if text == "" {
			text = "0"
		}
		coefficient, _ := new(big.Int).SetString(text, 10)
		if n.hasSmallCoefficient() != coefficient.IsInt64() || coefficient.IsInt64() && n.smallCoefficient != coefficient.Int64() {
			t.Fatalf("incorrect cache for %s", n.Snapshot())
		}
		restored, err := RestoreSnapshot(n.Snapshot())
		if err != nil || restored != n {
			t.Fatalf("restore %s: got %+v / %v", n.Snapshot(), restored, err)
		}
		// The cache must not share mutable math/big state with a caller.
		read := n.coefficientInt()
		read.SetInt64(123)
		if n.coefficientInt().Cmp(coefficient) != 0 {
			t.Fatal("coefficient read mutated the Number")
		}
	}
	// Existing saves contain text and exponents only; restore rebuilds the cache.
	n, err := RestoreSnapshot(`["250",-2,""]`)
	got, arithmeticErr := Calculate("+", n, FromInt(1))
	if err != nil || arithmeticErr != nil || got.String() != "3.50" || n.Snapshot() != `["250",-2,""]` {
		t.Fatalf("legacy restore arithmetic: %s / %v / %v", got.String(), err, arithmeticErr)
	}
}

func TestNegationAcrossCoefficientCacheBounds(t *testing.T) {
	for _, s := range []string{"0.00", "2.50", "9223372036854775807", "-9223372036854775808", "9223372036854775808", "-9223372036854775809"} {
		n := number(t, s)
		before := n.Snapshot()
		negated := n.Negate()
		want := new(big.Rat).Neg(n.Rat())
		if negated.Rat().Cmp(want) != 0 || negated.Negate() != n || n.Snapshot() != before {
			t.Fatalf("negate %s: %s", before, negated.Snapshot())
		}
		// Exercise the new Number immediately, including a wide-to-small negate.
		got, err := Calculate("+", negated, FromInt(1))
		want.Add(want, big.NewRat(1, 1))
		if err != nil || got.Rat().Cmp(want) != 0 {
			t.Fatalf("negated arithmetic %s: %s / %v", before, got.Snapshot(), err)
		}
	}
	n := FromInt(math.MinInt64).withComparisonExp(new(big.Int).Lsh(big.NewInt(1), 70))
	if n.Negate().comparisonExponent != n.comparisonExponent || n.Negate().Negate() != n {
		t.Fatal("negation lost an extended comparison exponent")
	}
}

func BenchmarkSmallArithmetic(b *testing.B) {
	x, y := FromInt(610), FromInt(987)
	for b.Loop() {
		n, err := Calculate("+", x, y)
		if err != nil || n.smallCoefficient != 1597 {
			b.Fatal(n, err)
		}
	}
}

func BenchmarkSmallComparison(b *testing.B) {
	x, y := FromInt(610), FromInt(987)
	for b.Loop() {
		if x.Compare(y) != -1 {
			b.Fatal("incorrect comparison")
		}
	}
}
