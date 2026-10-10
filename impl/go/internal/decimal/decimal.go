package decimal

import (
	"errors"
	"math"
	"math/big"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	coreunicode "github.com/odogono/odgn-talk/impl/go/internal/unicode"
)

const MinExponent = -6176
const Precision = 34

// Number is immutable. The zero value is the number 0; coefficients are
// signed decimal digits, stored as text so copies cannot alias a mutable Int.
// Coefficients that fit int64 are also cached; the zero value's cache is valid.
type Number struct {
	coefficient        string
	exponent           int
	comparisonExponent string
	// Zero also marks an uncached coefficient outside int64; canonical zero
	// text (including the Number zero value's empty text) distinguishes it.
	smallCoefficient int64
}
type Error struct{ Code, Operator string }

func (e *Error) Error() string { return e.Code + ": " + e.Operator }

var invalid = errors.New("invalid decimal")
var syntax = regexp.MustCompile(`^-?(?:[0-9]+(?:\.[0-9]+)?|0x[0-9a-fA-F]+)$`)
var jsonSyntax = regexp.MustCompile(`^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$`)

func Trim(s string) string {
	ascii := true
	for i := range s {
		if s[i] >= utf8.RuneSelf {
			ascii = false
			break
		}
	}
	if ascii {
		return strings.TrimFunc(s, coreunicode.WhiteSpace)
	}
	boundaries, e := coreunicode.Boundaries(s)
	if e != nil {
		return s
	}
	first, last := 0, len(boundaries)-1
	for first < last {
		cp, _ := utf8.DecodeRuneInString(s[boundaries[first]:])
		if !coreunicode.WhiteSpace(cp) {
			break
		}
		first++
	}
	for first < last {
		cp, _ := utf8.DecodeRuneInString(s[boundaries[last-1]:])
		if !coreunicode.WhiteSpace(cp) {
			break
		}
		last--
	}
	return s[boundaries[first]:boundaries[last]]
}
func Parse(s string) (Number, error) {
	s = Trim(s)
	if !syntax.MatchString(s) {
		return Number{}, invalid
	}
	neg := strings.HasPrefix(s, "-")
	s = strings.TrimPrefix(s, "-")
	exponent := 0
	var c *big.Int
	if strings.HasPrefix(s, "0x") {
		c, _ = new(big.Int).SetString(s[2:], 16)
	} else {
		if i := strings.IndexByte(s, '.'); i >= 0 {
			exponent = -(len(s) - i - 1)
			s = s[:i] + s[i+1:]
		}
		c, _ = new(big.Int).SetString(s, 10)
	}
	if neg {
		c.Neg(c)
	}
	return checked(c, exponent)
}

// ParseJSON applies an RFC 8259 exponent without rounding the input.
func ParseJSON(s string) (Number, error) {
	if !jsonSyntax.MatchString(s) {
		return Number{}, invalid
	}
	exponent := 0
	if i := strings.IndexAny(s, "eE"); i >= 0 {
		e, err := strconv.ParseInt(s[i+1:], 10, 32)
		if err != nil {
			return Number{}, invalid
		}
		exponent = int(e)
		s = s[:i]
	}
	if i := strings.IndexByte(s, '.'); i >= 0 {
		exponent -= len(s) - i - 1
		s = s[:i] + s[i+1:]
	}
	// checked rejects these anyway; rejecting them first keeps a long digit
	// string from Host input out of big.Int's quadratic conversions.
	if len(strings.TrimLeft(strings.TrimPrefix(s, "-"), "0")) > Precision {
		return Number{}, invalid
	}
	c, _ := new(big.Int).SetString(s, 10)
	// A positive exponent must be rescaled even for zero, but never allocate
	// a giant power for malformed Host input.
	if exponent > 0 {
		if c.Sign() != 0 && len(new(big.Int).Abs(c).String())+exponent > Precision {
			return Number{}, invalid
		}
		if c.Sign() != 0 {
			c.Mul(c, pow10(exponent))
		}
		exponent = 0
	}
	return checked(c, exponent)
}
func checked(c *big.Int, exponent int) (Number, error) {
	if exponent < MinExponent || exponent > 0 || len(new(big.Int).Abs(c).String()) > Precision {
		return Number{}, invalid
	}
	return fromCoefficient(c, exponent), nil
}
func fromCoefficient(c *big.Int, exponent int) Number {
	n := Number{coefficient: c.String(), exponent: exponent}
	if c.IsInt64() {
		n.smallCoefficient = c.Int64()
	}
	return n
}
func fromSmallCoefficient(c int64, exponent int) Number {
	return Number{coefficient: strconv.FormatInt(c, 10), exponent: exponent, smallCoefficient: c}
}
func FromFloat(f float64) (Number, error) {
	if math.IsNaN(f) || math.IsInf(f, 0) || math.Abs(f) >= 1e34 {
		return Number{}, invalid
	}
	return ParseJSON(strconv.FormatFloat(f, 'g', -1, 64))
}
func FromInt(i int64) Number { return fromSmallCoefficient(i, 0) }
func FromUint(i uint64) Number {
	if i <= math.MaxInt64 {
		return FromInt(int64(i))
	}
	return Number{coefficient: strconv.FormatUint(i, 10)}
}
func (n Number) hasSmallCoefficient() bool {
	return n.smallCoefficient != 0 || n.coefficient == "0" || n.coefficient == ""
}
func (n Number) coefficientInt() *big.Int {
	if n.hasSmallCoefficient() {
		return big.NewInt(n.smallCoefficient)
	}
	c, _ := new(big.Int).SetString(n.coefficient, 10)
	return c
}
func (n Number) Exponent() int { return n.exponent }
func (n Number) Sign() int     { return n.coefficientInt().Sign() }
func (n Number) Negate() Number {
	var negated Number
	if n.hasSmallCoefficient() && n.smallCoefficient != math.MinInt64 {
		negated = fromSmallCoefficient(-n.smallCoefficient, n.exponent)
	} else {
		c := n.coefficientInt()
		negated = fromCoefficient(c.Neg(c), n.exponent)
	}
	n.coefficient = negated.coefficient
	n.smallCoefficient = negated.smallCoefficient
	return n
}
func (n Number) String() string {
	c := n.coefficientInt()
	negative := c.Sign() < 0
	s := c.Abs(c).String()
	if n.exponent < 0 {
		places := -n.exponent
		if len(s) <= places {
			s = strings.Repeat("0", places-len(s)+1) + s
		}
		i := len(s) - places
		s = s[:i] + "." + s[i:]
	}
	if negative {
		s = "-" + s
	}
	return s
}
func pow10(n int) *big.Int     { return new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(n)), nil) }
func (n Number) Rat() *big.Rat { return new(big.Rat).SetFrac(n.coefficientInt(), pow10(-n.exponent)) }
func (n Number) Compare(m Number) int {
	if n.comparisonExponent == "" && m.comparisonExponent == "" && n.exponent == m.exponent {
		if n.hasSmallCoefficient() && m.hasSmallCoefficient() {
			a, b := n.smallCoefficient, m.smallCoefficient
			if a < b {
				return -1
			}
			if a > b {
				return 1
			}
			return 0
		}
	}
	a, b := n.coefficientInt(), m.coefficientInt()
	as, bs := a.Sign(), b.Sign()
	if as != bs {
		if as < bs {
			return -1
		}
		return 1
	}
	if as == 0 {
		return 0
	}
	ad, bd := a.Abs(a).String(), b.Abs(b).String()
	orders := new(big.Int).Sub(new(big.Int).Add(n.comparisonExp(), big.NewInt(int64(len(ad)))), new(big.Int).Add(m.comparisonExp(), big.NewInt(int64(len(bd)))))
	order := orders.Sign()
	if order == 0 {
		length := max(len(ad), len(bd))
		order = strings.Compare(ad+strings.Repeat("0", length-len(ad)), bd+strings.Repeat("0", length-len(bd)))
	}
	if order < 0 {
		order = -1
	} else if order > 0 {
		order = 1
	}
	return order * as
}

func (n Number) Integer() (*big.Int, bool) { r := n.Rat(); return new(big.Int).Set(r.Num()), r.IsInt() }
func (n Number) Int64() (int64, error) {
	i, ok := n.Integer()
	if !ok || !i.IsInt64() {
		return 0, invalid
	}
	return i.Int64(), nil
}
func (n Number) Uint64() (uint64, error) {
	i, ok := n.Integer()
	if !ok || !i.IsUint64() {
		return 0, invalid
	}
	return i.Uint64(), nil
}
func (n Number) Float64() float64 { f, _ := n.Rat().Float64(); return f }

// Round first chooses the precision quantum, rounds the exact rational once,
// then chooses the nearest representable exponent to the operator's ideal.
func Round(r *big.Rat, ideal int, op string) (Number, *Error) {
	return roundScaled(r, 0, ideal, op, true)
}

// ComparisonStep preserves the precision and subnormal rules, but permits
// magnitudes above the Script number range. Equality must never raise, and
// valid Quantities can have Base Unit magnitudes beyond that range.
func (n Number) comparisonExp() *big.Int {
	if n.comparisonExponent != "" {
		e, _ := new(big.Int).SetString(n.comparisonExponent, 10)
		return e
	}
	return big.NewInt(int64(n.exponent))
}
func (n Number) withComparisonExp(e *big.Int) Number {
	if e.IsInt64() {
		n.exponent = int(e.Int64())
		n.comparisonExponent = ""
	} else {
		n.exponent = 0
		n.comparisonExponent = e.String()
	}
	return n
}
func ComparisonStep(op string, a, b Number) Number {
	x := new(big.Rat).SetFrac(a.coefficientInt(), b.coefficientInt())
	shift := new(big.Int).Sub(a.comparisonExp(), b.comparisonExp())
	if op == "*" {
		x.SetInt(new(big.Int).Mul(a.coefficientInt(), b.coefficientInt()))
		shift.Add(a.comparisonExp(), b.comparisonExp())
	}
	if shift.IsInt64() && shift.Int64() > -(1<<60) && shift.Int64() < 1<<60 {
		n, _ := roundScaled(x, int(shift.Int64()), int(shift.Int64()), op, false)
		return n
	}
	if shift.Sign() < 0 {
		return fromSmallCoefficient(0, MinExponent)
	}
	// At a very large positive scale the subnormal bound cannot participate.
	// Round only the coefficient ratio, then restore the arbitrary-size scale.
	n, _ := roundScaled(x, 0, 0, op, false)
	return n.withComparisonExp(new(big.Int).Add(shift, big.NewInt(int64(n.exponent))))
}

// RepeatComparison applies rounded factors without expanding a Unit exponent.
// A stable coefficient allows its exponent progression to jump in one step.
func RepeatComparison(op string, n, f Number, power *big.Int) Number {
	remaining := new(big.Int).Set(power)
	for remaining.Sign() > 0 {
		before := n
		n = ComparisonStep(op, n, f)
		remaining.Sub(remaining, big.NewInt(1))
		if n.coefficient == before.coefficient {
			delta := new(big.Int).Sub(n.comparisonExp(), before.comparisonExp())
			jump := new(big.Int).Set(remaining)
			if delta.Sign() < 0 {
				distance := new(big.Int).Sub(n.comparisonExp(), big.NewInt(MinExponent))
				maximum := new(big.Int).Quo(distance, new(big.Int).Neg(delta))
				if jump.Cmp(maximum) > 0 {
					jump = maximum
				}
			}
			n = n.withComparisonExp(new(big.Int).Add(n.comparisonExp(), new(big.Int).Mul(jump, delta)))
			remaining.Sub(remaining, jump)
		}
	}
	return n
}

// RepeatComparisonPair keeps two applications of the same rounded recurrence
// in step. Once their numeric states merge, all subsequent factors preserve
// equality, even when their stored exponents differ.
func RepeatComparisonPair(op string, a, b, f Number, power *big.Int) (Number, Number, bool) {
	remaining := new(big.Int).Set(power)
	for remaining.Sign() > 0 {
		beforeA, beforeB := a, b
		a, b = ComparisonStep(op, a, f), ComparisonStep(op, b, f)
		remaining.Sub(remaining, big.NewInt(1))
		if a.Compare(b) == 0 {
			return a, b, true
		}
		if a.coefficient == beforeA.coefficient && b.coefficient == beforeB.coefficient {
			return RepeatComparison(op, a, f, remaining), RepeatComparison(op, b, f, remaining), false
		}
	}
	return a, b, false
}

func roundScaled(r *big.Rat, shift, ideal int, op string, bounded bool) (Number, *Error) {
	if bounded {
		ideal = min(0, ideal)
	}
	ideal = max(MinExponent, ideal)
	if r.Sign() == 0 {
		return fromSmallCoefficient(0, ideal), nil
	}
	negative := r.Sign() < 0
	numerator := new(big.Int).Abs(r.Num())
	denominator := r.Denom()
	exponent := MinExponent
	if numerator.Sign() != 0 {
		adjusted := len(numerator.String()) - len(denominator.String())
		if adjusted >= 0 {
			if numerator.Cmp(new(big.Int).Mul(denominator, pow10(adjusted))) < 0 {
				adjusted--
			}
		} else if new(big.Int).Mul(numerator, pow10(-adjusted)).Cmp(denominator) < 0 {
			adjusted--
		}
		if adjusted+shift < MinExponent-1 {
			return fromSmallCoefficient(0, ideal), nil
		}
		if bounded && adjusted+shift >= Precision {
			return Number{}, &Error{"overflow", op}
		}
		exponent = max(MinExponent, adjusted+shift-Precision+1)
	}
	scaledN, scaledD := new(big.Int).Set(numerator), new(big.Int).Set(denominator)
	if exponent-shift <= 0 {
		scaledN.Mul(scaledN, pow10(shift-exponent))
	} else {
		scaledD.Mul(scaledD, pow10(exponent-shift))
	}
	c, rem := new(big.Int), new(big.Int)
	c.QuoRem(scaledN, scaledD, rem)
	tie := new(big.Int).Lsh(rem, 1).Cmp(scaledD)
	if tie > 0 || (tie == 0 && c.Bit(0) == 1) {
		c.Add(c, big.NewInt(1))
	}
	for len(c.String()) > Precision {
		c.Quo(c, big.NewInt(10))
		exponent++
	}
	if bounded && (exponent > 0 || (c.Sign() != 0 && len(c.String())+exponent > Precision)) {
		return Number{}, &Error{"overflow", op}
	}
	if c.Sign() == 0 {
		return fromSmallCoefficient(0, ideal), nil
	}
	// Remove only exact zeros on the path toward the ideal exponent.
	for exponent < ideal {
		q, m := new(big.Int), new(big.Int)
		q.QuoRem(c, big.NewInt(10), m)
		if m.Sign() != 0 {
			break
		}
		c = q
		exponent++
	}
	for exponent > ideal && (c.Sign() == 0 || len(c.String()) < Precision) {
		c.Mul(c, big.NewInt(10))
		exponent--
	}
	if negative {
		c.Neg(c)
	}
	return fromCoefficient(c, exponent), nil
}
func Calculate(op string, a, b Number) (Number, *Error) {
	if n, ok := calculateSmall(op, a, b); ok {
		return n, nil
	}
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
	case "/", "div", "mod":
		if y.Sign() == 0 {
			return Number{}, &Error{"division by zero", op}
		}
		quotient := new(big.Rat).Quo(x, y)
		if op == "/" {
			x = quotient
			ideal = a.exponent - b.exponent
		} else {
			integer := new(big.Int).Quo(quotient.Num(), quotient.Denom())
			if op == "div" {
				x.SetInt(integer)
				ideal = 0
			} else {
				x.Sub(x, new(big.Rat).Mul(new(big.Rat).SetInt(integer), y))
			}
		}
	case "^":
		return power(a, b)
	default:
		return Number{}, &Error{"unknown operator", op}
	}
	return Round(x, ideal, op)
}

// Integer powers use exact rationals for small exponents. Larger exponents
// use outward-rounded intervals and increase precision until both endpoints
// give the same decimal, keeping huge Host exponents from building huge Ints.
func power(a, b Number) (Number, *Error) {
	n, ok := b.Integer()
	if !ok {
		return fractionalPower(a, b)
	}
	if n.Sign() == 0 {
		return FromInt(1), nil
	}
	idealBig := new(big.Int).Mul(n, big.NewInt(int64(a.exponent)))
	ideal := MinExponent
	if idealBig.Sign() >= 0 {
		ideal = 0
	} else if idealBig.IsInt64() {
		ideal = max(MinExponent, int(idealBig.Int64()))
	}
	if a.Sign() == 0 {
		if n.Sign() < 0 {
			return Number{}, &Error{"division by zero", "^"}
		}
		return Round(new(big.Rat), ideal, "^")
	}
	negative := a.Sign() < 0 && n.Bit(0) == 1
	x := a.Rat()
	x.Abs(x)
	if n.Sign() < 0 {
		x.Inv(x)
	}
	count := new(big.Int).Abs(n)
	if count.IsInt64() && count.Int64() <= 1024 && count.Int64()*int64(max(x.Num().BitLen(), x.Denom().BitLen())) <= 100000 {
		r := new(big.Rat).SetFrac(new(big.Int).Exp(x.Num(), count, nil), new(big.Int).Exp(x.Denom(), count, nil))
		if negative {
			r.Neg(r)
		}
		return Round(r, ideal, "^")
	}
	if x.Cmp(big.NewRat(1, 1)) == 0 {
		r := big.NewRat(1, 1)
		if negative {
			r.Neg(r)
		}
		return Round(r, ideal, "^")
	}
	// Here x already includes the reciprocal for negative integer powers.
	result, e := approximatePower(x, new(big.Rat).SetInt(count), ideal)
	if negative {
		result = result.Negate()
	}
	return result, e
}
