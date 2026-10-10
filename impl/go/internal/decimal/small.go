package decimal

import (
	"math"
	"strconv"
	"strings"
)

func (n Number) coefficientOrZero() string {
	if n.coefficient == "" {
		return "0"
	}
	return n.coefficient
}

// calculateSmall keeps exact, representable coefficients out of math/big.
// Overflow or rounding falls back to the general decimal implementation.
func calculateSmall(op string, a, b Number) (Number, bool) {
	if a.comparisonExponent != "" || b.comparisonExponent != "" || a.exponent > 0 || b.exponent > 0 {
		return Number{}, false
	}
	x, xe := strconv.ParseInt(a.coefficientOrZero(), 10, 64)
	y, ye := strconv.ParseInt(b.coefficientOrZero(), 10, 64)
	if xe != nil || ye != nil {
		return Number{}, false
	}
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
	return Number{coefficient: strconv.FormatInt(z, 10), exponent: e}, true
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

// Digits counts the coefficient's digits after leading zeros, as the Cost
// Model's digits measure does.
func (n Number) Digits() int {
	return len(strings.TrimLeft(strings.TrimPrefix(n.coefficient, "-"), "0"))
}
