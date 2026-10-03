package machine

import (
	"fmt"
	"github.com/odogono/odgn-talk/impl/go/internal/decimal"
	"github.com/odogono/odgn-talk/impl/go/internal/value"
	"math/big"
	"slices"
	"unicode/utf8"
)

func convert(v value.Value, target string) (value.Value, *value.Value) {
	bad := func() (value.Value, *value.Value) {
		e := failure("can't convert", value.Pair{Key: "value", Val: v}, value.Pair{Key: "to", Val: text(target)})
		return value.Value{}, &e
	}
	switch target {
	case "text":
		if v.Kind == value.Bytes {
			if !utf8.Valid(v.Bytes) {
				return bad()
			}
			return text(string(v.Bytes)), nil
		}
		return text(textForm(v)), nil
	case "bytes":
		if v.Kind == value.Bytes {
			return v, nil
		}
		if v.Kind == value.Text {
			return value.NewBytes([]byte(v.Text)), nil
		}
		return bad()
	case "number":
		if v.Kind == value.Number {
			return v, nil
		}
		if v.Kind == value.Text {
			n, e := decimal.Parse(v.Text)
			if e == nil {
				return value.Value{Kind: value.Number, Number: n}, nil
			}
		}
		return bad()
	case "civil date", "instant":
		if target == "civil date" && v.Kind == value.CivilDate || target == "instant" && v.Kind == value.Instant {
			return v, nil
		}
		if v.Kind == value.Text {
			var x value.Value
			var e error
			if target == "civil date" {
				x, e = value.ParseCivil(v.Text)
			} else {
				x, e = value.ParseInstant(v.Text)
			}
			if e == nil {
				return x, nil
			}
			if e, ok := e.(*value.DateRangeError); ok {
				return value.Value{}, yearError(big.NewInt(int64(e.Year)))
			}
		}
		return bad()
	}
	unit, e := value.ParseUnit(target)
	if e != nil {
		return bad()
	}
	x := v
	if x.Kind == value.Text {
		source := decimal.Trim(x.Text)
		reader := value.Reader{Text: source}
		x, e = reader.Value()
		if e != nil || reader.At != len(source) {
			return bad()
		}
	}
	if x.Kind == value.Number {
		q, e := value.NewQuantity(x.Number, unit.String())
		if e == nil {
			return q, nil
		}
		return bad()
	}
	if x.Kind != value.Quantity || !x.Unit.Compatible(unit) {
		return bad()
	}
	base, e := x.Unit.Convert(x.Number, true)
	if e != nil {
		return bad()
	}
	n, e := unit.Convert(base, false)
	if e != nil {
		return bad()
	}
	return value.Value{Kind: value.Quantity, Number: n, Unit: unit}, nil
}
func kindTest(v value.Value, kind string) bool {
	if kind == "integer" {
		if v.Kind != value.Number {
			return false
		}
		_, ok := v.Number.Integer()
		return ok
	}
	return value.KindNames[v.Kind] == kind
}
func empty(v value.Value) bool {
	switch v.Kind {
	case value.Text:
		return v.Text == ""
	case value.Bytes:
		return len(v.Bytes) == 0
	case value.List:
		return len(v.Items) == 0
	case value.Map:
		return len(v.Entries) == 0
	}
	return false
}
func membership(a, b value.Value, folded bool) (bool, int64, *value.Value) {
	switch b.Kind {
	case value.List:
		for j, x := range b.Items {
			if equal(a, x, folded) {
				return true, int64(j + 1), nil
			}
		}
		return false, int64(len(b.Items)), nil
	case value.Map:
		if a.Kind != value.Text {
			e := wrong("text", a)
			return false, 0, &e
		}
		for j, p := range b.Entries {
			key := p.Key
			if folded {
				key = fold(text(key)).Text
			}
			if equal(a, text(key), folded) {
				return true, int64(j + 1), nil
			}
		}
		return false, int64(len(b.Entries)), nil
	case value.Range:
		lo, e := a.Compare(b.Items[0])
		if e != nil {
			err := comparisonError(b.Items[0], a)
			return false, 2, &err
		}
		hi, e := a.Compare(b.Items[1])
		if e != nil {
			err := comparisonError(a, b.Items[1])
			return false, 2, &err
		}
		return lo >= 0 && hi <= 0, 2, nil
	}
	e := wrong("list, map or range", b)
	return false, 0, &e
}
func comparisonError(a, b value.Value) value.Value {
	if a.Kind == value.List && b.Kind == value.List {
		for j := 0; j < min(len(a.Items), len(b.Items)); j++ {
			if !a.Items[j].Equal(b.Items[j]) {
				return comparisonError(a.Items[j], b.Items[j])
			}
		}
	}
	return failure("can't compare", value.Pair{Key: "left", Val: a}, value.Pair{Key: "right", Val: b})
}
func mapWrite(whole value.Value, key string, part value.Value, deleting bool) (value.Value, *value.Value) {
	if whole.Kind != value.Map {
		e := wrong("map", whole)
		return value.Value{}, &e
	}
	pairs := slices.Clone(whole.Entries)
	for j, p := range pairs {
		if p.Key == key {
			if deleting {
				pairs = append(pairs[:j], pairs[j+1:]...)
			} else {
				pairs[j].Val = part
			}
			v, _ := value.NewMap(pairs)
			v.CoreMessage = whole.CoreMessage && key != "message"
			return v, nil
		}
	}
	if !deleting {
		pairs = append(pairs, value.Pair{Key: key, Val: part})
	}
	v, _ := value.NewMap(pairs)
	v.CoreMessage = whole.CoreMessage && key != "message"
	return v, nil
}
func integerRange(v value.Value) bool {
	if v.Kind != value.Range {
		return false
	}
	for _, x := range v.Items {
		if x.Kind != value.Number {
			return false
		}
		if _, ok := x.Number.Integer(); !ok {
			return false
		}
	}
	return true
}
func rangeList(v value.Value, first, last int64) (value.Value, error) {
	return rangeListBig(v, big.NewInt(first), big.NewInt(last))
}
func rangeListBig(v value.Value, first, last *big.Int) (value.Value, error) {
	if !integerRange(v) {
		return value.Value{}, fmt.Errorf("not integer range")
	}
	if last.Cmp(first) < 0 {
		return value.NewList(nil), nil
	}
	count := new(big.Int).Add(new(big.Int).Sub(last, first), big.NewInt(1))
	items := make([]value.Value, count.Int64())
	start, _ := v.Items[0].Number.Integer()
	start.Add(start, new(big.Int).Sub(first, big.NewInt(1)))
	current, _ := decimal.Round(new(big.Rat).SetInt(start), 0, "+")
	for j := range items {
		items[j] = value.Value{Kind: value.Number, Number: current}
		if j < len(items)-1 {
			current, _ = decimal.Calculate("+", current, decimal.FromInt(1))
		}
	}
	return value.NewList(items), nil
}
