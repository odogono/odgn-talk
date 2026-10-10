package machine

import (
	"math"
	"math/big"
	"unicode/utf8"

	"github.com/odogono/odgn-talk/impl/go/internal/generated"
	coreunicode "github.com/odogono/odgn-talk/impl/go/internal/unicode"
	"github.com/odogono/odgn-talk/impl/go/internal/value"
)

type Measures struct {
	InputSize                                                 int64 // a message is an internal record, not a Value
	ResultValues                                              []value.Value
	InputPresent                                              bool
	ResultPresent                                             bool
	Input, Result                                             value.Value
	Args                                                      []value.Value
	Scanned, Steps, Program, Frames, Clauses, Count, Declared int64
}

func contents(v value.Value) int64 {
	if v.Kind == value.List {
		return v.ListContents(Size)
	}
	if v.Kind == value.Map {
		return v.MapContents(Size)
	}
	var n int64
	if v.Kind == value.Replacement {
		n = Size(v.Replacement().Subject)
		for _, x := range v.Replacement().Matches {
			n += Size(x)
		}
		for _, s := range v.Replacement().Parts {
			n += Size(text(s))
		}
	}
	for _, x := range v.Items() {
		n += Size(x)
	}
	for _, p := range v.Entries() {
		n += int64(16+len(p.Key)) + Size(p.Val)
	}
	if v.Function() != nil {
		for _, p := range v.Function().Captures {
			n += Size(p.Val)
		}
	}
	return n
}
func measure(code uint8, v value.Value) int64 {
	switch code {
	case generated.MeasureSize:
		if v.Kind == value.Iterator {
			return Size(v.Iterator().Snapshot)
		}
		if v.Kind == value.BinaryReader {
			return Size(v.Reader().Snapshot)
		}
		return Size(v)
	case generated.MeasureContents:
		return contents(v)
	case generated.MeasureCharacters:
		if v.Kind == value.Text {
			b, _ := coreunicode.Boundaries(v.Text())
			return int64(len(b) - 1)
		}
	case generated.MeasureScalars:
		if v.Kind == value.Text {
			return int64(utf8.RuneCountInString(v.Text()))
		}
	case generated.MeasureUtf8:
		if v.Kind == value.Text {
			return int64(len(v.Text()))
		}
	case generated.MeasureBytes:
		if v.Kind == value.Bytes {
			return int64(len(v.Bytes()))
		}
	case generated.MeasureItems:
		if v.Kind == value.List {
			return int64(v.ListLen())
		}
		if v.Kind == value.Range && v.Items()[0].Kind == value.Number && v.Items()[1].Kind == value.Number {
			a, ok := v.Items()[0].Number().Integer()
			b, ok2 := v.Items()[1].Number().Integer()
			if ok && ok2 && b.Cmp(a) >= 0 {
				n := new(big.Int).Sub(b, a)
				n.Add(n, big.NewInt(1))
				if !n.IsInt64() {
					return math.MaxInt64
				}
				return n.Int64()
			}
		}
	case generated.MeasureEntries:
		return int64(v.MapLen())
	case generated.MeasureDigits:
		if v.Kind == value.Number || v.Kind == value.Quantity {
			return int64(max(1, v.Number().Digits()))
		}
	case generated.MeasureProgram:
		if v.Kind == value.Pattern {
			return int64(patternSize(v.Text()))
		}
	}
	return 0
}

// Size evaluates the logical size formula for the value's kind.
func Size(v value.Value) int64 {
	if int(v.Kind) < len(sizes) && sizes[v.Kind] != nil {
		return evaluate(sizes[v.Kind], Measures{}, v)
	}
	panic("missing logical size")
}

// sizes holds each kind's compiled logical size formula, indexed by
// value.Kind. A kind without one is nil.
var sizes = func() [][]generated.CostTerm {
	out := make([][]generated.CostTerm, len(value.KindNames))
	for k, name := range value.KindNames {
		for _, s := range generated.CostSizes {
			if s.Of == name {
				out[k] = s.Terms
			}
		}
	}
	return out
}()

func evaluate(terms []generated.CostTerm, m Measures, v value.Value) int64 {
	var total int64
	for _, t := range terms {
		factor, divisor := t.Factor, t.Divisor
		var n int64
		switch {
		case t.Measure == generated.MeasureConstant:
			n = 1
		case t.Subject != generated.SubjectNone:
			x := v
			switch t.Subject {
			case generated.SubjectInput:
				x = m.Input
				if !m.InputPresent && m.InputSize == 0 && m.Input.Kind == value.Nothing {
					continue
				}
			case generated.SubjectResult:
				x = m.Result
				if !m.ResultPresent && m.Result.Kind == value.Nothing {
					continue
				}
			case generated.SubjectV:
			default:
				if arg := int(t.Subject - generated.SubjectX1); arg < len(m.Args) {
					x = m.Args[arg]
				}
			}
			n = measure(t.Measure, x)
			if t.Subject == generated.SubjectInput && t.Measure == generated.MeasureSize && m.InputSize > 0 {
				n = m.InputSize
			}
			if t.Subject == generated.SubjectResult && m.ResultValues != nil {
				n = 0
				for _, result := range m.ResultValues {
					n += measure(t.Measure, result)
				}
			}
		default:
			switch t.Measure {
			case generated.MeasureScanned:
				n = m.Scanned
			case generated.MeasureSteps:
				n = m.Steps
			case generated.MeasureFrames:
				n = m.Frames
			case generated.MeasureClauses:
				n = m.Clauses
			case generated.MeasureCount:
				n = m.Count
			case generated.MeasureDeclared:
				n = m.Declared
			}
		}
		// Evaluate each rounded term exactly, then saturate the internal
		// counter. Overflow must never turn an unaffordable charge negative.
		if total >= 0 && factor >= 0 && n >= 0 && divisor > 0 && (factor == 0 || n <= (math.MaxInt64-(divisor-1))/factor) {
			term := (factor*n + divisor - 1) / divisor
			if term > math.MaxInt64-total {
				return math.MaxInt64
			}
			total += term
			continue
		}
		term := new(big.Int).Mul(big.NewInt(factor), big.NewInt(n))
		term.Add(term, big.NewInt(divisor-1))
		term.Quo(term, big.NewInt(divisor))
		term.Add(term, big.NewInt(total))
		if !term.IsInt64() {
			return math.MaxInt64
		}
		total = term.Int64()
	}
	return total
}

// Charge evaluates a Cost Model key's rate. An instruction charges its
// lowered rate through ChargeRate, without looking the key up.
func Charge(key string, m Measures) (int64, int64) {
	if rate, ok := generated.CostRateIndex[key]; ok {
		return ChargeRate(rate, m)
	}
	panic("missing Cost Model key: " + key)
}

// ChargeRate evaluates the rate at an index in generated.CostRates.
func ChargeRate(rate int, m Measures) (int64, int64) {
	if rate < 0 || rate >= len(generated.CostRates) {
		panic("missing Cost Model rate")
	}
	r := &generated.CostRates[rate]
	return evaluate(r.Fuel, m, value.Value{}), evaluate(r.Alloc, m, value.Value{})
}
