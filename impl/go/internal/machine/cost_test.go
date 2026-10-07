package machine

import (
	"fmt"
	"math"
	"math/big"
	"testing"

	"github.com/odogono/odgn-talk/impl/go/internal/value"
)

func TestCostTermsRoundAndSaturateWithoutOverflow(t *testing.T) {
	for _, count := range []int64{0, 1, 7, 8, 9, math.MaxInt64 / 16, math.MaxInt64/16 + 1, math.MaxInt64 - 1, math.MaxInt64} {
		for _, factor := range []int64{0, 1, 16, math.MaxInt64} {
			for _, divisor := range []int64{1, 8, math.MaxInt64} {
				expr := fmt.Sprintf("3 + %d * count / %d", factor, divisor)
				want := new(big.Int).Mul(big.NewInt(factor), big.NewInt(count))
				want.Add(want, big.NewInt(divisor-1))
				want.Quo(want, big.NewInt(divisor))
				want.Add(want, big.NewInt(3))
				expected := int64(math.MaxInt64)
				if want.IsInt64() {
					expected = want.Int64()
				}
				if got := formula(expr, Measures{Count: count}, value.Value{}); got != expected {
					t.Fatalf("%s with count=%d: got %d; want %d", expr, count, got, expected)
				}
			}
		}
	}
}
