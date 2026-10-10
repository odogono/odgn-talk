package value

import (
	"fmt"
	"math/big"
	"strings"

	"github.com/odogono/odgn-talk/impl/go/internal/decimal"
	"github.com/odogono/odgn-talk/impl/go/internal/generated"
)

type Slot struct {
	Unit  int
	Power *big.Int
}
type Unit struct{ Slots []Slot }

func kindIndex(name string) int {
	for i, k := range generated.Units.Kind {
		if k.Name == name {
			return i
		}
	}
	panic("generated Unit Kind missing")
}
func unitIndex(name string) int {
	for i, u := range generated.Units.Unit {
		if u.Name == name || u.Plural != "" && u.Plural == name {
			return i
		}
	}
	return -1
}
func ParseUnit(s string) (Unit, error) {
	if s == "" || s == "1" {
		return Unit{}, fmt.Errorf("unknown unit %q", s)
	}
	parts := strings.Split(s, "/")
	if len(parts) > 2 {
		return Unit{}, fmt.Errorf("invalid unit %q", s)
	}
	slots := make([]Slot, len(generated.Units.Kind))
	for i := range slots {
		slots[i].Unit = -1
	}
	for side, part := range parts {
		if side == 0 && part == "1" && len(parts) == 2 {
			continue
		}
		for _, factor := range strings.Split(part, "*") {
			bits := strings.Split(factor, "^")
			if len(bits) > 2 {
				return Unit{}, fmt.Errorf("invalid unit %q", s)
			}
			u := unitIndex(bits[0])
			if u < 0 {
				return Unit{}, fmt.Errorf("unknown unit %q", bits[0])
			}
			power := big.NewInt(1)
			if len(bits) == 2 {
				if bits[1] == "" || bits[1][0] == '0' {
					return Unit{}, fmt.Errorf("invalid unit exponent")
				}
				for _, c := range bits[1] {
					if c < '0' || c > '9' {
						return Unit{}, fmt.Errorf("invalid unit exponent")
					}
				}
				p, ok := new(big.Int).SetString(bits[1], 10)
				if !ok || p.Sign() <= 0 {
					return Unit{}, fmt.Errorf("invalid unit exponent")
				}
				power = p
			}
			if side == 1 {
				power = new(big.Int).Neg(power)
			}
			k := kindIndex(generated.Units.Unit[u].Kind)
			if generated.Units.Kind[k].Calendar && (len(parts) != 1 || len(strings.Split(part, "*")) != 1 || len(bits) != 1) {
				return Unit{}, fmt.Errorf("calendar unit must stand alone without exponent")
			}
			// A lexical Unit may repeat a spelling, but not mix two Units in a slot.
			if slots[k].Unit >= 0 && slots[k].Unit != u {
				return Unit{}, fmt.Errorf("two units in one slot")
			}
			if slots[k].Unit < 0 {
				slots[k].Unit = u
			}
			if slots[k].Power == nil {
				slots[k].Power = new(big.Int)
			}
			slots[k].Power.Add(slots[k].Power, power)
		}
	}
	var out Unit
	for _, slot := range slots {
		if slot.Power != nil && slot.Power.Sign() != 0 {
			out.Slots = append(out.Slots, slot)
		}
	}
	if !out.ValidCalendar() {
		return Unit{}, fmt.Errorf("invalid calendar unit")
	}
	return out, nil
}
func (u Unit) ValidCalendar() bool {
	for _, s := range u.Slots {
		if generated.Units.Kind[kindIndex(generated.Units.Unit[s.Unit].Kind)].Calendar {
			return len(u.Slots) == 1 && s.Power.Cmp(big.NewInt(1)) == 0
		}
	}
	return true
}
func (u Unit) String() string {
	var numerator, denominator []string
	for _, s := range u.Slots {
		text := generated.Units.Unit[s.Unit].Name
		p := new(big.Int).Abs(s.Power)
		if p.Cmp(big.NewInt(1)) != 0 {
			text += "^" + p.String()
		}
		if s.Power.Sign() > 0 {
			numerator = append(numerator, text)
		} else {
			denominator = append(denominator, text)
		}
	}
	out := strings.Join(numerator, "*")
	if out == "" {
		out = "1"
	}
	if len(denominator) > 0 {
		out += "/" + strings.Join(denominator, "*")
	}
	return out
}
func (u Unit) Display(n decimal.Number) string {
	if len(u.Slots) == 1 && u.Slots[0].Power.Cmp(big.NewInt(1)) == 0 {
		entry := generated.Units.Unit[u.Slots[0].Unit]
		if entry.Plural != "" && new(big.Rat).Abs(n.Rat()).Cmp(big.NewRat(1, 1)) != 0 {
			return entry.Plural
		}
	}
	return u.String()
}
func (u Unit) Dimensions() map[string]*big.Int {
	dims := map[string]*big.Int{}
	for _, s := range u.Slots {
		kind := generated.Units.Kind[kindIndex(generated.Units.Unit[s.Unit].Kind)]
		dimension := kind.Dimension
		power := new(big.Int).Set(s.Power)
		if kind.Calendar {
			dimension = "calendar"
		}
		if dimension == "length^3" {
			dimension = "length"
			power.Mul(power, big.NewInt(3))
		}
		if dims[dimension] == nil {
			dims[dimension] = new(big.Int)
		}
		dims[dimension].Add(dims[dimension], power)
		if dims[dimension].Sign() == 0 {
			delete(dims, dimension)
		}
	}
	return dims
}
func (u Unit) Compatible(v Unit) bool {
	a, b := u.Dimensions(), v.Dimensions()
	if len(a) != len(b) {
		return false
	}
	for k, p := range a {
		if b[k] == nil || b[k].Cmp(p) != 0 {
			return false
		}
	}
	return true
}

// factors visits catalogue factors in order without expanding powers into
// slices. Identity factors cannot affect either the value or its exponent.
func (u Unit) factors(intoBase bool, visit func(decimal.Number, *big.Int, bool) error) error {
	for _, denominator := range []bool{!intoBase, intoBase} {
		for _, slot := range u.Slots {
			entry := generated.Units.Unit[slot.Unit]
			kind := generated.Units.Kind[kindIndex(entry.Kind)]
			ns, ds := []decimal.Number{}, []decimal.Number{}
			if entry.Factor != "" {
				n, _ := decimal.Parse(entry.Factor)
				ns = append(ns, n)
			} else {
				ns = append(ns, decimal.FromInt(entry.Ratio[0]))
				ds = append(ds, decimal.FromInt(entry.Ratio[1]))
			}
			if kind.Factor != "" {
				n, _ := decimal.Parse(kind.Factor)
				ns = append(ns, n)
			}
			power := new(big.Int).Set(slot.Power)
			if power.Sign() < 0 {
				power = new(big.Int).Neg(power)
				ns, ds = ds, ns
			}
			factors := ns
			if denominator {
				factors = ds
			}
			// Preserve the catalogue sequence. The volume factors commute here
			// because mL and its Kind factor are both exactly 0.001.
			for _, factor := range factors {
				if factor.String() == "1" {
					continue
				}
				if e := visit(factor, power, denominator); e != nil {
					return e
				}
			}
		}
	}
	return nil
}
func (u Unit) Convert(n decimal.Number, intoBase bool) (decimal.Number, error) {
	e := u.factors(intoBase, func(f decimal.Number, power *big.Int, denominator bool) error {
		op := "*"
		if denominator == intoBase {
			op = "/"
		}
		for remaining := new(big.Int).Set(power); remaining.Sign() > 0; remaining.Sub(remaining, big.NewInt(1)) {
			previous := n
			var e *decimal.Error
			n, e = decimal.Calculate(op, n, f)
			if e != nil {
				return e
			}
			if n == previous {
				break
			}
		}
		return nil
	})
	return n, e
}
func (u Unit) comparisonMagnitude(n decimal.Number) decimal.Number {
	_ = u.factors(true, func(f decimal.Number, power *big.Int, denominator bool) error {
		op := "*"
		if denominator {
			op = "/"
		}
		n = decimal.RepeatComparison(op, n, f, power)
		return nil
	})
	return n
}

// Large powers can usually be ordered by disjoint logarithm bounds. Every
// normal 34-digit rounding changes the logarithm by less than 2e-33. Keep
// that cumulative allowance; use the ordinary rounded steps if bounds overlap
// or any prefix might reach the subnormal region.
func (u Unit) magnitudeBounds(n decimal.Number) (lo, hi *big.Rat, ok bool) {
	if n.Sign() == 0 {
		return nil, nil, false
	}
	lo, hi = decimal.LogBounds(new(big.Rat).Abs(n.Rat()))
	floor := big.NewRat(-14000, 1)
	if lo.Cmp(floor) < 0 {
		return nil, nil, false
	}
	e := u.factors(true, func(f decimal.Number, power *big.Int, denominator bool) error {
		fl, fh := decimal.LogBounds(f.Rat())
		count := new(big.Rat).SetInt(power)
		fl.Mul(fl, count)
		fh.Mul(fh, count)
		if denominator {
			lo.Sub(lo, fh)
			hi.Sub(hi, fl)
		} else {
			lo.Add(lo, fl)
			hi.Add(hi, fh)
		}
		allowance := new(big.Rat).Mul(count, new(big.Rat).SetFrac(big.NewInt(2), new(big.Int).Exp(big.NewInt(10), big.NewInt(33), nil)))
		lo.Sub(lo, allowance)
		hi.Add(hi, allowance)
		if lo.Cmp(floor) < 0 {
			return fmt.Errorf("subnormal prefix")
		}
		return nil
	})
	return lo, hi, e == nil
}
func quantityOrder(a, b Value) int {
	as, bs := a.Number().Sign(), b.Number().Sign()
	if as == 0 && bs == 0 {
		return 0
	}
	if as != bs {
		// A normal-prefix proof also proves that conversion cannot erase a
		// sign. Otherwise retain the exact steps for subnormal rounding to zero.
		_, _, ao := a.Unit().magnitudeBounds(a.Number())
		_, _, bo := b.Unit().magnitudeBounds(b.Number())
		if (as == 0 || ao) && (bs == 0 || bo) {
			if as < bs {
				return -1
			}
			return 1
		}
		return a.Unit().comparisonMagnitude(a.Number()).Compare(b.Unit().comparisonMagnitude(b.Number()))
	}
	// Equal inputs traverse exactly the same rounded conversion steps.
	if a.Unit().String() == b.Unit().String() && a.Number().Compare(b.Number()) == 0 {
		return 0
	}
	large := false
	for _, u := range []Unit{a.Unit(), b.Unit()} {
		for _, s := range u.Slots {
			large = large || new(big.Int).Abs(s.Power).Cmp(big.NewInt(128)) > 0
		}
	}
	if !large {
		return a.Unit().comparisonMagnitude(a.Number()).Compare(b.Unit().comparisonMagnitude(b.Number()))
	}
	al, ah, ao := a.Unit().magnitudeBounds(a.Number())
	bl, bh, bo := b.Unit().magnitudeBounds(b.Number())
	if ao && bo {
		if ah.Cmp(bl) < 0 {
			return -as
		}
		if al.Cmp(bh) > 0 {
			return as
		}
	}
	if a.Unit().String() == b.Unit().String() {
		an, bn := a.Number(), b.Number()
		merged := false
		_ = a.Unit().factors(true, func(f decimal.Number, power *big.Int, denominator bool) error {
			if merged {
				return nil
			}
			op := "*"
			if denominator {
				op = "/"
			}
			an, bn, merged = decimal.RepeatComparisonPair(op, an, bn, f, power)
			return nil
		})
		if merged {
			return 0
		}
		return an.Compare(bn)
	}
	return a.Unit().comparisonMagnitude(a.Number()).Compare(b.Unit().comparisonMagnitude(b.Number()))
}
