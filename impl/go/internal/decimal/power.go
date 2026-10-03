package decimal

import "math/big"

// An interval's operations round outward. Transcendental evaluation therefore
// stops only when both bounds choose the same Spec decimal, never merely when
// a fixed number of guard digits looks sufficient.
type interval struct {
	lo, hi    *big.Float
	precision uint
}

func bound(p uint, mode big.RoundingMode) *big.Float { return new(big.Float).SetPrec(p).SetMode(mode) }
func rational(r *big.Rat, p uint) interval {
	return interval{bound(p, big.ToNegativeInf).SetRat(r), bound(p, big.ToPositiveInf).SetRat(r), p}
}
func integer(n int64, p uint) interval { return rational(big.NewRat(n, 1), p) }
func (a interval) add(b interval) interval {
	p := a.precision
	return interval{bound(p, big.ToNegativeInf).Add(a.lo, b.lo), bound(p, big.ToPositiveInf).Add(a.hi, b.hi), p}
}
func (a interval) sub(b interval) interval {
	p := a.precision
	return interval{bound(p, big.ToNegativeInf).Sub(a.lo, b.hi), bound(p, big.ToPositiveInf).Sub(a.hi, b.lo), p}
}
func (a interval) mul(b interval) interval {
	p := a.precision
	var lo, hi *big.Float
	for _, x := range []*big.Float{a.lo, a.hi} {
		for _, y := range []*big.Float{b.lo, b.hi} {
			l := bound(p, big.ToNegativeInf).Mul(x, y)
			h := bound(p, big.ToPositiveInf).Mul(x, y)
			if lo == nil || l.Cmp(lo) < 0 {
				lo = l
			}
			if hi == nil || h.Cmp(hi) > 0 {
				hi = h
			}
		}
	}
	return interval{lo, hi, p}
}
func (a interval) div(b interval) interval {
	p := a.precision
	one := bound(p, big.ToNearestEven).SetInt64(1)
	inverse := interval{bound(p, big.ToNegativeInf).Quo(one, b.hi), bound(p, big.ToPositiveInf).Quo(one, b.lo), p}
	return a.mul(inverse)
}

// logMantissa uses ln(m)=2 sum z^(2k+1)/(2k+1), z=(m-1)/(m+1).
// Range reduction puts m in [1,2], so z<=1/3. The geometric tail bound is
// explicit, including when outward rounding changes the final term.
func logMantissa(m *big.Rat, p uint) interval {
	z := new(big.Rat).Quo(new(big.Rat).Sub(m, big.NewRat(1, 1)), new(big.Rat).Add(m, big.NewRat(1, 1)))
	term := rational(z, p)
	square := term.mul(term)
	sum := integer(0, p)
	for k := int64(0); ; k++ {
		sum = sum.add(term.div(integer(2*k+1, p)))
		term = term.mul(square)
		tail := term.mul(integer(2, p)).div(integer(2*k+3, p)).div(integer(1, p).sub(square))
		if tail.hi.Sign() == 0 || tail.hi.MantExp(nil) < -int(p)-8 {
			result := sum.mul(integer(2, p))
			result.hi = bound(p, big.ToPositiveInf).Add(result.hi, tail.hi)
			return result
		}
	}
}
func logarithm(x *big.Rat, p uint) interval {
	k := x.Num().BitLen() - x.Denom().BitLen()
	m := new(big.Rat).Set(x)
	if k >= 0 {
		m.Quo(m, new(big.Rat).SetInt(new(big.Int).Lsh(big.NewInt(1), uint(k))))
	} else {
		m.Mul(m, new(big.Rat).SetInt(new(big.Int).Lsh(big.NewInt(1), uint(-k))))
	}
	if m.Cmp(big.NewRat(1, 1)) < 0 {
		m.Mul(m, big.NewRat(2, 1))
		k--
	}
	return logMantissa(m, p).add(logMantissa(big.NewRat(2, 1), p).mul(integer(int64(k), p)))
}

// exponential evaluates a small non-negative argument using Taylor's series.
// For argument<=1/2 the tail after the next term is less than twice that term.
func exponential(x *big.Float, p uint) interval {
	negative := x.Sign() < 0
	y := bound(p, big.ToNearestEven).Abs(x)
	squares := 0
	half := bound(p, big.ToNearestEven).SetRat(big.NewRat(1, 2))
	for y.Cmp(half) > 0 {
		y.SetMantExp(y, -1)
		squares++
	}
	r, _ := y.Rat(nil)
	arg := rational(r, p)
	term, sum := integer(1, p), integer(1, p)
	for n := int64(1); ; n++ {
		term = term.mul(arg).div(integer(n, p))
		sum = sum.add(term)
		next := term.mul(arg).div(integer(n+1, p))
		tail := next.mul(integer(2, p))
		if tail.hi.Sign() == 0 || tail.hi.MantExp(nil) < -int(p)-8 {
			sum.hi = bound(p, big.ToPositiveInf).Add(sum.hi, tail.hi)
			break
		}
	}
	for range squares {
		sum = sum.mul(sum)
	}
	if negative {
		sum = integer(1, p).div(sum)
	}
	return sum
}
func approximatePower(x, y *big.Rat, ideal int) (Number, *Error) {
	for p := uint(256); ; p *= 2 {
		exponent := logarithm(x, p).mul(rational(y, p))
		// These conservative cutoffs are beyond either decimal boundary and
		// prevent astronomical powers from reaching big.Float's exponent limit.
		if exponent.lo.Cmp(integer(100, p).hi) > 0 {
			return Number{}, &Error{"overflow", "^"}
		}
		if exponent.hi.Cmp(integer(-15000, p).lo) < 0 {
			return Round(new(big.Rat), ideal, "^")
		}
		lower := exponential(exponent.lo, p)
		upper := exponential(exponent.hi, p)
		lr, _ := lower.lo.Rat(nil)
		ur, _ := upper.hi.Rat(nil)
		l, le := Round(lr, ideal, "^")
		u, ue := Round(ur, ideal, "^")
		if le != nil && ue != nil {
			return Number{}, le
		}
		if le == nil && ue == nil && l == u {
			return l, nil
		}
	}
}

// Detect exact rational roots before transcendental evaluation. Exact ties
// must take the half-even branch, rather than straddle it at every precision.
func exactRoot(x *big.Rat, q *big.Int) (*big.Rat, bool) {
	if !q.IsInt64() || q.Sign() <= 0 || q.Int64() > int64(max(x.Num().BitLen(), x.Denom().BitLen())) {
		return nil, false
	}
	root := func(n *big.Int) (*big.Int, bool) {
		if n.Cmp(big.NewInt(1)) <= 0 {
			return new(big.Int).Set(n), true
		}
		if q.Int64() == 2 {
			r := new(big.Int).Sqrt(n)
			return r, new(big.Int).Mul(r, r).Cmp(n) == 0
		}
		lo := new(big.Int)
		hi := new(big.Int).Lsh(big.NewInt(1), uint((int64(n.BitLen())+q.Int64()-1)/q.Int64()))
		for new(big.Int).Sub(hi, lo).Cmp(big.NewInt(1)) > 0 {
			mid := new(big.Int).Rsh(new(big.Int).Add(lo, hi), 1)
			c := new(big.Int).Exp(mid, q, nil).Cmp(n)
			if c == 0 {
				return mid, true
			}
			if c < 0 {
				lo = mid
			} else {
				hi = mid
			}
		}
		return lo, new(big.Int).Exp(lo, q, nil).Cmp(n) == 0
	}
	a, ok := root(x.Num())
	if !ok {
		return nil, false
	}
	b, ok := root(x.Denom())
	if !ok {
		return nil, false
	}
	return new(big.Rat).SetFrac(a, b), true
}
func fractionalPower(a, b Number) (Number, *Error) {
	if a.Sign() < 0 {
		return Number{}, &Error{"out of domain", "power"}
	}
	if a.Sign() == 0 {
		if b.Sign() < 0 {
			return Number{}, &Error{"division by zero", "^"}
		}
		return FromInt(0), nil
	}
	x, y := a.Rat(), b.Rat()
	if x.Cmp(big.NewRat(1, 1)) == 0 {
		return FromInt(1), nil
	}
	if root, ok := exactRoot(x, y.Denom()); ok {
		n := new(big.Int).Abs(y.Num())
		if n.IsInt64() && n.Int64() <= 1024 && n.Int64()*int64(max(root.Num().BitLen(), root.Denom().BitLen())) <= 100000 {
			r := new(big.Rat).SetFrac(new(big.Int).Exp(root.Num(), n, nil), new(big.Int).Exp(root.Denom(), n, nil))
			if y.Sign() < 0 {
				r.Inv(r)
			}
			return Round(r, 0, "^")
		}
	}
	return approximatePower(x, y, 0)
}

// LogBounds supports proofs of Quantity ordering without expanding large Unit
// powers. These are outward bounds, not approximate float64 rankings.
func LogBounds(x *big.Rat) (lo, hi *big.Rat) {
	v := logarithm(x, 256)
	lo, _ = v.lo.Rat(nil)
	hi, _ = v.hi.Rat(nil)
	return
}
