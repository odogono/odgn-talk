package machine

import (
	"github.com/odogono/odgn-talk/impl/go/internal/value"
	"math/big"
	"time"
)

func builtinDate(name string, args []value.Value) (value.Value, *value.Value) {
	v := args[0]
	fail := func(e value.Value) (value.Value, *value.Value) { return value.Value{}, &e }
	domain := func(x value.Value) (value.Value, *value.Value) {
		return fail(failure("out of domain", value.Pair{Key: "function", Val: text(name)}, value.Pair{Key: "value", Val: x}))
	}
	if name == "toCivil" || name == "toInstant" {
		expected, kind := "civil date", value.CivilDate
		if name == "toCivil" {
			expected, kind = "instant", value.Instant
		}
		if v.Kind != kind {
			return fail(wrong(expected, v))
		}
		if name == "toInstant" && !v.Date.HasTime {
			return domain(v)
		}
		offset := args[1]
		s, _ := value.ParseUnit("s")
		if offset.Kind != value.Quantity {
			return fail(wrong("quantity", offset))
		}
		if !offset.Unit.Compatible(s) {
			return domain(offset)
		}
		n, e := offset.Unit.Convert(offset.Number, true)
		if e != nil {
			return domain(offset)
		}
		minutes := new(big.Rat).Quo(n.Rat(), big.NewRat(60, 1))
		if !minutes.IsInt() || new(big.Int).Abs(minutes.Num()).Cmp(big.NewInt(1440)) >= 0 {
			return domain(offset)
		}
		t := civilTime(v)
		if name == "toCivil" {
			t = time.Unix(v.Seconds, int64(v.Nanos)).UTC()
		}
		d := time.Duration(minutes.Num().Int64()) * time.Minute
		if name == "toInstant" {
			d = -d
		}
		t = t.Add(d)
		if t.Year() < 1 || t.Year() > 9999 {
			return value.Value{}, yearError(big.NewInt(int64(t.Year())))
		}
		if name == "toInstant" {
			out, _ := value.NewInstant(t.Unix(), int32(t.Nanosecond()))
			return out, nil
		}
		out, _ := value.NewCivil(value.DateFields{Year: t.Year(), Month: int(t.Month()), Day: t.Day(), HasTime: true, Hour: t.Hour(), Minute: t.Minute(), Second: t.Second(), Nanosecond: t.Nanosecond()})
		return out, nil
	}
	if v.Kind != value.CivilDate {
		return fail(wrong("civil date", v))
	}
	f := v.Date
	t := civilTime(v)
	n := 0
	switch name {
	case "year":
		n = f.Year
	case "month":
		n = f.Month
	case "day":
		n = f.Day
	case "hasTime":
		return boolean(f.HasTime), nil
	case "hour", "minute", "second", "nanosecond":
		if !f.HasTime {
			return domain(v)
		}
		switch name {
		case "hour":
			n = f.Hour
		case "minute":
			n = f.Minute
		case "second":
			n = f.Second
		case "nanosecond":
			n = f.Nanosecond
		}
	case "weekday":
		n = (int(t.Weekday())+6)%7 + 1
	case "dayOfYear":
		n = t.YearDay()
	case "isoWeek":
		_, n = t.ISOWeek()
	case "isoWeekYear":
		n, _ = t.ISOWeek()
	}
	return integer(int64(n)), nil
}
