package machine

import (
	"github.com/odogono/odgn-talk/impl/go/internal/decimal"
	"github.com/odogono/odgn-talk/impl/go/internal/generated"
	"github.com/odogono/odgn-talk/impl/go/internal/value"
	"math/big"
	"slices"
	"time"
)

// Add applies the machine's addition rules without charging a Run.
func Add(a, b value.Value) (value.Value, *value.Value) {
	return arithmetic("+", a, b)
}

func arithmetic(op string, a, b value.Value) (value.Value, *value.Value) {
	bad := func(e value.Value) (value.Value, *value.Value) { return value.Value{}, &e }
	numericError := func(e error) (value.Value, *value.Value) {
		code := e.(*decimal.Error).Code
		if code == "out of domain" {
			return bad(failure(code, value.Pair{Key: "function", Val: text("power")}, value.Pair{Key: "value", Val: a}))
		}
		if code == "overflow" {
			return bad(failure(code, value.Pair{Key: "operator", Val: text(op)}))
		}
		return bad(failure(code))
	}
	incompatible := func() (value.Value, *value.Value) {
		return bad(failure("incompatible units", value.Pair{Key: "left", Val: text(a.Unit.String())}, value.Pair{Key: "right", Val: text(b.Unit.String())}))
	}
	if a.Kind == value.Instant || a.Kind == value.CivilDate {
		return dateArithmetic(op, a, b)
	}
	if a.Kind != value.Number && a.Kind != value.Quantity {
		return bad(wrong("number", a))
	}
	expected := "number"
	if a.Kind == value.Quantity && (op == "+" || op == "-") {
		expected = "quantity"
	}
	if b.Kind != value.Number && b.Kind != value.Quantity {
		return bad(wrong(expected, b))
	}
	if (op == "div" || op == "mod") && (a.Kind == value.Quantity || b.Kind == value.Quantity) {
		v := a
		if a.Kind == value.Number {
			v = b
		}
		return bad(wrong("number", v))
	}
	if op == "^" {
		if b.Kind != value.Number {
			return bad(wrong("number", b))
		}
		if a.Kind == value.Quantity {
			n, ok := b.Number.Integer()
			if !ok || n.Sign() <= 0 {
				return bad(wrong("integer", b))
			}
			u := value.Unit{Slots: slices.Clone(a.Unit.Slots)}
			for j, s := range u.Slots {
				u.Slots[j].Power = new(big.Int).Mul(s.Power, n)
			}
			if !u.ValidCalendar() {
				return incompatible()
			}
			x, e := decimal.Calculate(op, a.Number, b.Number)
			if e != nil {
				return numericError(e)
			}
			return value.Value{Kind: value.Quantity, Number: x, Unit: u}, nil
		}
	}
	if a.Kind == value.Number && b.Kind == value.Number {
		n, e := decimal.Calculate(op, a.Number, b.Number)
		if e != nil {
			return numericError(e)
		}
		return value.Value{Kind: value.Number, Number: n}, nil
	}
	if op == "+" || op == "-" {
		if a.Kind != value.Quantity {
			return bad(wrong("number", b))
		}
		if b.Kind != value.Quantity {
			return bad(wrong("quantity", b))
		}
		if !a.Unit.Compatible(b.Unit) {
			return incompatible()
		}
		n, e := b.Unit.Convert(b.Number, true)
		if e != nil {
			return numericError(e)
		}
		n, e = a.Unit.Convert(n, false)
		if e != nil {
			return numericError(e)
		}
		n, de := decimal.Calculate(op, a.Number, n)
		if de != nil {
			return numericError(de)
		}
		return value.Value{Kind: value.Quantity, Number: n, Unit: a.Unit}, nil
	}
	u := value.Unit{Slots: slices.Clone(a.Unit.Slots)}
	for _, right := range b.Unit.Slots {
		power := new(big.Int).Set(right.Power)
		if op == "/" {
			power.Neg(power)
		}
		found := false
		for j, left := range u.Slots {
			if generated.Units.Unit[left.Unit].Kind == generated.Units.Unit[right.Unit].Kind {
				u.Slots[j].Power = new(big.Int).Add(left.Power, power)
				found = true
				break
			}
		}
		if !found {
			u.Slots = append(u.Slots, value.Slot{Unit: right.Unit, Power: power})
		}
	}
	u.Slots = slices.DeleteFunc(u.Slots, func(s value.Slot) bool { return s.Power.Sign() == 0 })
	slices.SortFunc(u.Slots, func(a, b value.Slot) int {
		kind := func(s value.Slot) int {
			for j, k := range generated.Units.Kind {
				if k.Name == generated.Units.Unit[s.Unit].Kind {
					return j
				}
			}
			return -1
		}
		return kind(a) - kind(b)
	})
	if !u.ValidCalendar() {
		return incompatible()
	}
	an, e := a.Unit.Convert(a.Number, true)
	if e != nil {
		return numericError(e)
	}
	bn, e := b.Unit.Convert(b.Number, true)
	if e != nil {
		return numericError(e)
	}
	n, de := decimal.Calculate(op, an, bn)
	if de != nil {
		return numericError(de)
	}
	n, e = u.Convert(n, false)
	if e != nil {
		return numericError(e)
	}
	kind := value.Quantity
	if len(u.Slots) == 0 {
		kind = value.Number
	}
	return value.Value{Kind: kind, Number: n, Unit: u}, nil
}

func roundInteger(r *big.Rat) *big.Int {
	q, rem := new(big.Int), new(big.Int)
	q.QuoRem(r.Num(), r.Denom(), rem)
	twice := new(big.Int).Lsh(new(big.Int).Abs(rem), 1)
	c := twice.Cmp(r.Denom())
	if c > 0 || c == 0 && q.Bit(0) == 1 {
		q.Add(q, big.NewInt(int64(r.Sign())))
	}
	return q
}
func floorDiv(n, d *big.Int) *big.Int {
	q, r := new(big.Int), new(big.Int)
	q.QuoRem(n, d, r)
	if r.Sign() < 0 {
		q.Sub(q, big.NewInt(1))
	}
	return q
}
func civilTime(v value.Value) time.Time {
	f := v.Date
	return time.Date(f.Year, time.Month(f.Month), f.Day, f.Hour, f.Minute, f.Second, f.Nanosecond, time.UTC)
}
func instantNanos(v value.Value) *big.Int {
	if v.Kind == value.CivilDate {
		t := civilTime(v)
		v.Seconds = t.Unix()
		v.Nanos = int32(t.Nanosecond())
	}
	n := new(big.Int).Mul(big.NewInt(v.Seconds), big.NewInt(1e9))
	return n.Add(n, big.NewInt(int64(v.Nanos)))
}
func yearAtDays(days *big.Int) *big.Int {
	cycles := floorDiv(days, big.NewInt(146097))
	remaining := new(big.Int).Sub(days, new(big.Int).Mul(cycles, big.NewInt(146097))).Int64()
	year := int64(1)
	for {
		length := int64(365)
		if year%4 == 0 && (year%100 != 0 || year%400 == 0) {
			length++
		}
		if remaining < length {
			break
		}
		remaining -= length
		year++
	}
	return new(big.Int).Add(new(big.Int).Mul(cycles, big.NewInt(400)), big.NewInt(year))
}
func yearError(year *big.Int) *value.Value {
	n, _ := decimal.Round(new(big.Rat).SetInt(year), 0, "+")
	e := failure("out of range", value.Pair{Key: "field", Val: text("year")}, value.Pair{Key: "value", Val: value.Value{Kind: value.Number, Number: n}})
	return &e
}
func dateArithmetic(op string, a, b value.Value) (value.Value, *value.Value) {
	bad := func(e value.Value) (value.Value, *value.Value) { return value.Value{}, &e }
	if op != "+" && op != "-" {
		return bad(wrong("number", a))
	}
	if op == "-" && (b.Kind == value.Instant || b.Kind == value.CivilDate) {
		if a.Kind != b.Kind || a.Kind == value.CivilDate && a.Date.HasTime != b.Date.HasTime {
			return bad(wrong(value.KindNames[a.Kind], b))
		}
		n := new(big.Int).Sub(instantNanos(a), instantNanos(b))
		r := new(big.Rat).SetFrac(n, big.NewInt(1e9))
		unit := "s"
		if a.Kind == value.CivilDate && !a.Date.HasTime {
			r.Quo(r, big.NewRat(86400, 1))
			unit = "day"
		}
		number, _ := decimal.Round(r, 0, "-")
		v, _ := value.NewQuantity(number, unit)
		return v, nil
	}
	if b.Kind != value.Quantity {
		return bad(wrong("quantity", b))
	}
	left := "s"
	if a.Kind == value.CivilDate && !a.Date.HasTime {
		left = "day"
	}
	incompatible := func() (value.Value, *value.Value) {
		return bad(failure("incompatible units", value.Pair{Key: "left", Val: text(left)}, value.Pair{Key: "right", Val: text(b.Unit.String())}))
	}
	monthUnit, _ := value.ParseUnit("month")
	secondsUnit, _ := value.ParseUnit("s")
	if b.Unit.Compatible(monthUnit) {
		if a.Kind != value.CivilDate {
			return incompatible()
		}
		n, e := b.Unit.Convert(b.Number, true)
		if e != nil {
			return incompatible()
		}
		months, ok := n.Integer()
		if !ok {
			left = "month"
			return incompatible()
		}
		if op == "-" {
			months.Neg(months)
		}
		months.Add(months, big.NewInt(int64(a.Date.Year*12+a.Date.Month-1)))
		year := floorDiv(months, big.NewInt(12))
		month := new(big.Int).Sub(months, new(big.Int).Mul(year, big.NewInt(12))).Int64() + 1
		if year.Sign() <= 0 || year.Cmp(big.NewInt(9999)) > 0 {
			return value.Value{}, yearError(year)
		}
		f := a.Date
		f.Year = int(year.Int64())
		f.Month = int(month)
		f.Day = min(f.Day, time.Date(f.Year, time.Month(f.Month)+1, 0, 0, 0, 0, 0, time.UTC).Day())
		v, _ := value.NewCivil(f)
		return v, nil
	}
	if !b.Unit.Compatible(secondsUnit) {
		return incompatible()
	}
	n, e := b.Unit.Convert(b.Number, true)
	if e != nil {
		return incompatible()
	}
	seconds := n.Rat()
	if a.Kind == value.CivilDate && !a.Date.HasTime {
		days := new(big.Rat).Quo(seconds, big.NewRat(86400, 1))
		if !days.IsInt() {
			return incompatible()
		}
	}
	delta := roundInteger(new(big.Rat).Mul(seconds, big.NewRat(1e9, 1)))
	if op == "-" {
		delta.Neg(delta)
	}
	ns := new(big.Int).Add(instantNanos(a), delta)
	sec := floorDiv(ns, big.NewInt(1e9))
	nano := new(big.Int).Sub(ns, new(big.Int).Mul(sec, big.NewInt(1e9))).Int64()
	if sec.Cmp(big.NewInt(-62135596800)) < 0 || sec.Cmp(big.NewInt(253402300799)) > 0 {
		days := floorDiv(new(big.Int).Add(sec, big.NewInt(62135596800)), big.NewInt(86400))
		return value.Value{}, yearError(yearAtDays(days))
	}
	if a.Kind == value.Instant {
		v, _ := value.NewInstant(sec.Int64(), int32(nano))
		return v, nil
	}
	t := time.Unix(sec.Int64(), nano).UTC()
	f := a.Date
	f.Year, f.Month, f.Day = t.Year(), int(t.Month()), t.Day()
	f.Hour, f.Minute, f.Second, f.Nanosecond = t.Hour(), t.Minute(), t.Second(), t.Nanosecond()
	v, _ := value.NewCivil(f)
	return v, nil
}
