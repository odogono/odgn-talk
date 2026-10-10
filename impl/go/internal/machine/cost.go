package machine

import (
	"math"
	"math/big"
	"strconv"
	"strings"
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
func measure(name string, v value.Value) int64 {
	switch name {
	case "size":
		if v.Kind == value.Iterator {
			return Size(v.Iterator().Snapshot)
		}
		if v.Kind == value.BinaryReader {
			return Size(v.Reader().Snapshot)
		}
		return Size(v)
	case "contents":
		return contents(v)
	case "characters":
		if v.Kind == value.Text {
			b, _ := coreunicode.Boundaries(v.Text())
			return int64(len(b) - 1)
		}
	case "scalars":
		if v.Kind == value.Text {
			return int64(utf8.RuneCountInString(v.Text()))
		}
	case "utf8":
		if v.Kind == value.Text {
			return int64(len(v.Text()))
		}
	case "bytes":
		if v.Kind == value.Bytes {
			return int64(len(v.Bytes()))
		}
	case "items":
		if v.Kind == value.List {
			return int64(len(v.Items()))
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
	case "entries":
		return int64(len(v.Entries()))
	case "digits":
		if v.Kind == value.Number || v.Kind == value.Quantity {
			return int64(max(1, v.Number().Digits()))
		}
	case "program":
		if v.Kind == value.Pattern {
			return int64(patternSize(v.Text()))
		}
	}
	return 0
}

// Size evaluates the logical size formula for the value's kind.
func Size(v value.Value) int64 {
	if int(v.Kind) < len(sizes) && sizes[v.Kind].known {
		return evaluate(sizes[v.Kind].terms, Measures{}, v)
	}
	panic("missing logical size")
}

// term is one "factor * token / divisor" part of a Cost Model formula. Its
// token is a constant, a measure of a subject such as size(result), or a count.
type term struct {
	factor, divisor  int64
	constant         int64
	measure, subject string
	arg              int // n in an xn subject
	counter          string
}

// parseFormula splits a Data File formula into terms. The tables below parse
// each formula once, so a charge only evaluates.
func parseFormula(s string) []term {
	if s == "" {
		return nil
	}
	var terms []term
	for _, text := range strings.Split(s, " + ") {
		parts := strings.Fields(text)
		t := term{factor: 1, divisor: 1}
		if len(parts) > 2 && parts[1] == "*" {
			t.factor, _ = strconv.ParseInt(parts[0], 10, 64)
			parts = parts[2:]
		}
		if len(parts) > 2 && parts[1] == "/" {
			t.divisor, _ = strconv.ParseInt(parts[2], 10, 64)
		}
		token := parts[0]
		at := strings.IndexByte(token, '(')
		switch {
		case token[0] >= '0' && token[0] <= '9':
			t.constant, _ = strconv.ParseInt(token, 10, 64)
		case at >= 0:
			t.measure, t.subject = token[:at], token[at+1:len(token)-1]
			if strings.HasPrefix(t.subject, "x") {
				t.arg, _ = strconv.Atoi(t.subject[1:])
			}
		default:
			switch token {
			case "scanned", "steps", "frames", "clauses", "count", "declared":
				t.counter = token
			default:
				panic("unknown cost measure: " + token)
			}
		}
		terms = append(terms, t)
	}
	return terms
}

type rate struct{ fuel, alloc []term }

var rates = func() map[string]rate {
	out := make(map[string]rate, len(generated.Costs.Rate))
	for _, r := range generated.Costs.Rate {
		out[r.Key] = rate{parseFormula(r.Fuel), parseFormula(r.Alloc)}
	}
	return out
}()

type sizeFormula struct {
	terms []term
	known bool
}

// sizes holds each kind's logical size formula, indexed by value.Kind.
var sizes = func() []sizeFormula {
	out := make([]sizeFormula, len(value.KindNames))
	for k, name := range value.KindNames {
		for _, s := range generated.Costs.Size {
			if s.Of == name {
				out[k] = sizeFormula{parseFormula(s.Size), true}
			}
		}
	}
	return out
}()

func formula(s string, m Measures, v value.Value) int64 {
	return evaluate(parseFormula(s), m, v)
}
func evaluate(terms []term, m Measures, v value.Value) int64 {
	var total int64
	for _, t := range terms {
		factor, divisor := t.factor, t.divisor
		var n int64
		switch {
		case t.measure != "":
			x := v
			switch t.subject {
			case "input":
				x = m.Input
				if !m.InputPresent && m.InputSize == 0 && m.Input.Kind == value.Nothing {
					continue
				}
			case "result":
				x = m.Result
				if !m.ResultPresent && m.Result.Kind == value.Nothing {
					continue
				}
			default:
				if t.arg > 0 && t.arg <= len(m.Args) {
					x = m.Args[t.arg-1]
				}
			}
			n = measure(t.measure, x)
			if t.subject == "input" && t.measure == "size" && m.InputSize > 0 {
				n = m.InputSize
			}
			if t.subject == "result" && m.ResultValues != nil {
				n = 0
				for _, result := range m.ResultValues {
					n += measure(t.measure, result)
				}
			}
		case t.counter != "":
			switch t.counter {
			case "scanned":
				n = m.Scanned
			case "steps":
				n = m.Steps
			case "frames":
				n = m.Frames
			case "clauses":
				n = m.Clauses
			case "count":
				n = m.Count
			case "declared":
				n = m.Declared
			}
		default:
			n = t.constant
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

func Charge(key string, m Measures) (int64, int64) {
	if r, ok := rates[key]; ok {
		return evaluate(r.fuel, m, value.Value{}), evaluate(r.alloc, m, value.Value{})
	}
	panic("missing Cost Model key: " + key)
}
