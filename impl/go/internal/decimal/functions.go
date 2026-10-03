package decimal

import "math/big"

func (a interval) neg() interval {
	p := a.precision
	return interval{bound(p, big.ToNegativeInf).Neg(a.hi), bound(p, big.ToPositiveInf).Neg(a.lo), p}
}
func (a interval) sqrt() interval {
	p := a.precision
	return interval{bound(p, big.ToNegativeInf).Sqrt(a.lo), bound(p, big.ToPositiveInf).Sqrt(a.hi), p}
}
func (a interval) magnitude() *big.Float {
	x := bound(a.precision, big.ToPositiveInf).Abs(a.lo)
	y := bound(a.precision, big.ToPositiveInf).Abs(a.hi)
	if x.Cmp(y) < 0 {
		return y
	}
	return x
}
func (a interval) widen(error *big.Float) interval {
	p := a.precision
	return interval{bound(p, big.ToNegativeInf).Sub(a.lo, error), bound(p, big.ToPositiveInf).Add(a.hi, error), p}
}
func arctangentSeries(x interval) interval {
	p := x.precision
	square := x.mul(x)
	term, sum := x, x
	for k := int64(1); ; k++ {
		term = term.mul(square).neg()
		part := term.div(integer(2*k+1, p))
		sum = sum.add(part)
		next := term.mul(square).div(integer(2*k+3, p)).magnitude()
		if next.Sign() == 0 || next.MantExp(nil) < -int(p)-8 {
			return sum.widen(next)
		}
	}
}
func piInterval(p uint) interval {
	return arctangentSeries(rational(big.NewRat(1, 5), p)).mul(integer(16, p)).sub(arctangentSeries(rational(big.NewRat(1, 239), p)).mul(integer(4, p)))
}
func arctangent(x interval) interval {
	negative := x.hi.Sign() < 0
	if negative {
		x = x.neg()
	}
	halvings := 0
	for x.hi.Cmp(integer(1, x.precision).lo) > 0 || x.hi.Cmp(rational(big.NewRat(1, 4), x.precision).lo) > 0 {
		x = x.div(integer(1, x.precision).add(integer(1, x.precision).add(x.mul(x)).sqrt()))
		halvings++
	}
	result := arctangentSeries(x)
	for range halvings {
		result = result.mul(integer(2, x.precision))
	}
	if negative {
		result = result.neg()
	}
	return result
}
func sineCosineSeries(x interval, cosine bool) interval {
	p := x.precision
	square := x.mul(x)
	term, sum := x, x
	start := int64(1)
	if cosine {
		term, sum = integer(1, p), integer(1, p)
		start = 0
	}
	for k := start; ; k += 2 {
		term = term.mul(square).div(integer((k+1)*(k+2), p)).neg()
		sum = sum.add(term)
		next := term.mul(square).div(integer((k+3)*(k+4), p)).magnitude()
		if next.Sign() == 0 || next.MantExp(nil) < -int(p)-8 {
			return sum.widen(next)
		}
	}
}
func trig(x *big.Rat, p uint) (interval, interval, bool) {
	negative := x.Sign() < 0
	a := new(big.Rat).Abs(x)
	halfPi := piInterval(p).div(integer(2, p))
	ratio := rational(a, p).div(halfPi)
	floor := func(x *big.Float) *big.Int { n, _ := x.Int(nil); return n }
	first, last := floor(ratio.lo), floor(ratio.hi)
	if first.Cmp(last) != 0 {
		return interval{}, interval{}, false
	}
	reduced := rational(a, p).sub(halfPi.mul(rational(new(big.Rat).SetInt(first), p)))
	sin, cos := sineCosineSeries(reduced, false), sineCosineSeries(reduced, true)
	quadrant := new(big.Int).Mod(first, big.NewInt(4)).Int64()
	switch quadrant {
	case 1:
		sin, cos = cos, sin.neg()
	case 2:
		sin, cos = sin.neg(), cos.neg()
	case 3:
		sin, cos = cos.neg(), sin
	}
	if negative {
		sin = sin.neg()
	}
	return sin, cos, true
}

// Function encloses the exact mathematical value with outward-rounded
// intervals, increasing precision until both ends select the same Spec decimal.
// It never uses the Host's float64 transcendental functions.
func Function(name string, x, y Number) (Number, *Error) {
	domain := func() (Number, *Error) { return Number{}, &Error{"out of domain", name} }
	one := big.NewRat(1, 1)
	arg := x.Rat()
	switch name {
	case "sqrt":
		if x.Sign() < 0 {
			return domain()
		}
		half, _ := Parse("0.5")
		return Calculate("^", x, half)
	case "ln", "log10":
		if x.Sign() <= 0 {
			return domain()
		}
		if arg.Cmp(one) == 0 {
			return FromInt(0), nil
		}
	case "asin", "acos":
		if new(big.Rat).Abs(arg).Cmp(one) > 0 {
			return domain()
		}
	case "atan2":
		if x.Sign() == 0 && y.Sign() == 0 {
			return domain()
		}
	case "exp":
		if arg.Cmp(big.NewRat(100, 1)) > 0 {
			return Number{}, &Error{"overflow", name}
		}
		if arg.Cmp(big.NewRat(-15000, 1)) < 0 {
			return FromInt(0), nil
		}
	}
	if x.Sign() == 0 {
		switch name {
		case "sin", "tan", "asin", "atan":
			return FromInt(0), nil
		case "cos", "exp":
			return FromInt(1), nil
		}
	}
	for p := uint(256); ; p *= 2 {
		var result interval
		switch name {
		case "exp":
			a := rational(arg, p)
			lo, hi := exponential(a.lo, p), exponential(a.hi, p)
			result = interval{lo.lo, hi.hi, p}
		case "ln":
			result = logarithm(arg, p)
		case "log10":
			result = logarithm(arg, p).div(logarithm(big.NewRat(10, 1), p))
		case "sin", "cos", "tan":
			sin, cos, ok := trig(arg, p)
			if !ok {
				continue
			}
			result = sin
			if name == "cos" {
				result = cos
			}
			if name == "tan" {
				if cos.lo.Sign() <= 0 && cos.hi.Sign() >= 0 {
					continue
				}
				result = sin.div(cos)
			}
		case "atan":
			result = arctangent(rational(arg, p))
		case "asin", "acos":
			if new(big.Rat).Abs(arg).Cmp(one) == 0 {
				result = piInterval(p).div(integer(2, p))
				if x.Sign() < 0 {
					result = result.neg()
				}
			} else {
				denom := rational(new(big.Rat).Sub(one, new(big.Rat).Mul(arg, arg)), p).sqrt()
				result = arctangent(rational(arg, p).div(denom))
			}
			if name == "acos" {
				result = piInterval(p).div(integer(2, p)).sub(result)
				if x.Compare(FromInt(1)) == 0 {
					return FromInt(0), nil
				}
			}
		case "atan2":
			if y.Sign() == 0 {
				result = piInterval(p).div(integer(2, p))
				if x.Sign() < 0 {
					result = result.neg()
				}
			} else {
				result = arctangent(rational(new(big.Rat).Quo(arg, y.Rat()), p))
				if y.Sign() < 0 {
					if x.Sign() >= 0 {
						result = result.add(piInterval(p))
					} else {
						result = result.sub(piInterval(p))
					}
				}
			}
		default:
			return Number{}, &Error{"unknown function", name}
		}
		lo, _ := result.lo.Rat(nil)
		hi, _ := result.hi.Rat(nil)
		l, le := Round(lo, 0, name)
		h, he := Round(hi, 0, name)
		if le != nil && he != nil {
			return Number{}, le
		}
		if le == nil && he == nil && l == h {
			return l, nil
		}
	}
}
