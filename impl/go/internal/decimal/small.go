package decimal

import (
	"math"
)

// calculateSmall keeps exact, representable coefficients out of math/big.
// Overflow or rounding falls back to the general decimal implementation.
func calculateSmall(op string, a, b Number) (Number, bool) {
	if a.comparisonExponent != "" || b.comparisonExponent != "" || a.exponent > 0 || b.exponent > 0 {
		return Number{}, false
	}
	if !a.hasSmallCoefficient() || !b.hasSmallCoefficient() {
		return Number{}, false
	}
	x, y := a.smallCoefficient, b.smallCoefficient
	e := min(a.exponent, b.exponent)
	var z int64
	switch op {
	case "+", "-":
		var ok bool
		x, ok = scaleSmall(x, a.exponent-e)
		if !ok {
			return Number{}, false
		}
		y, ok = scaleSmall(y, b.exponent-e)
		if !ok {
			return Number{}, false
		}
		if op == "-" {
			if y == math.MinInt64 {
				return Number{}, false
			}
			y = -y
		}
		z = x + y
		if y > 0 && z < x || y < 0 && z > x {
			return Number{}, false
		}
	case "*":
		e = a.exponent + b.exponent
		if e < MinExponent || e > 0 {
			return Number{}, false
		}
		if x == math.MinInt64 && y == -1 || y == math.MinInt64 && x == -1 {
			return Number{}, false
		}
		z = x * y
		if y != 0 && z/y != x {
			return Number{}, false
		}
	default:
		return Number{}, false
	}
	return fromSmallCoefficient(z, e), true
}

func scaleSmall(x int64, places int) (int64, bool) {
	if places < 0 || places > 18 {
		return 0, false
	}
	for range places {
		if x > math.MaxInt64/10 || x < math.MinInt64/10 {
			return 0, false
		}
		x *= 10
	}
	return x, true
}
