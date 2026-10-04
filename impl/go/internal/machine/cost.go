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
	var n int64
	if v.Kind == value.Replacement {
		n = Size(v.Replacement.Subject)
		for _, x := range v.Replacement.Matches {
			n += Size(x)
		}
		for _, s := range v.Replacement.Parts {
			n += Size(text(s))
		}
	}
	for _, x := range v.Items {
		n += Size(x)
	}
	for _, p := range v.Entries {
		n += int64(16+len(p.Key)) + Size(p.Val)
	}
	if v.Function != nil {
		for _, p := range v.Function.Captures {
			n += Size(p.Val)
		}
	}
	return n
}
func measure(name string, v value.Value) int64 {
	switch name {
	case "size":
		if v.Kind == value.Iterator {
			return Size(v.Iterator.Snapshot)
		}
		if v.Kind == value.BinaryReader {
			return Size(v.Reader.Snapshot)
		}
		return Size(v)
	case "contents":
		return contents(v)
	case "characters":
		if v.Kind == value.Text {
			b, _ := coreunicode.Boundaries(v.Text)
			return int64(len(b) - 1)
		}
	case "scalars":
		if v.Kind == value.Text {
			return int64(utf8.RuneCountInString(v.Text))
		}
	case "utf8":
		if v.Kind == value.Text {
			return int64(len(v.Text))
		}
	case "bytes":
		if v.Kind == value.Bytes {
			return int64(len(v.Bytes))
		}
	case "items":
		if v.Kind == value.List {
			return int64(len(v.Items))
		}
		if v.Kind == value.Function && v.Function != nil {
			return int64(len(v.Function.Captures))
		}
		if v.Kind == value.Range && v.Items[0].Kind == value.Number && v.Items[1].Kind == value.Number {
			a, ok := v.Items[0].Number.Integer()
			b, ok2 := v.Items[1].Number.Integer()
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
		return int64(len(v.Entries))
	case "digits":
		if v.Kind == value.Number || v.Kind == value.Quantity {
			s := strings.TrimPrefix(v.Number.String(), "-")
			s = strings.ReplaceAll(s, ".", "")
			s = strings.TrimLeft(s, "0")
			return int64(max(1, len(s)))
		}
	case "program":
		if v.Kind == value.Pattern {
			return int64(patternSize(v.Text))
		}
	}
	return 0
}
func Size(v value.Value) int64 {
	for _, s := range generated.Costs.Size {
		if s.Of == value.KindNames[v.Kind] {
			return formula(s.Size, Measures{}, v)
		}
	}
	panic("missing logical size")
}
func formula(s string, m Measures, v value.Value) int64 {
	if s == "" {
		return 0
	}
	var total int64
	for _, term := range strings.Split(s, " + ") {
		parts := strings.Fields(term)
		factor := int64(1)
		divisor := int64(1)
		if len(parts) > 2 && parts[1] == "*" {
			factor, _ = strconv.ParseInt(parts[0], 10, 64)
			parts = parts[2:]
		}
		if len(parts) > 2 && parts[1] == "/" {
			divisor, _ = strconv.ParseInt(parts[2], 10, 64)
		}
		token := parts[0]
		n, err := strconv.ParseInt(token, 10, 64)
		if err != nil {
			if at := strings.IndexByte(token, '('); at >= 0 {
				subject := token[at+1 : len(token)-1]
				x := v
				switch subject {
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
					if strings.HasPrefix(subject, "x") {
						i, _ := strconv.Atoi(subject[1:])
						if i > 0 && i <= len(m.Args) {
							x = m.Args[i-1]
						}
					}
				}
				n = measure(token[:at], x)
				if subject == "input" && token[:at] == "size" && m.InputSize > 0 {
					n = m.InputSize
				}
				if subject == "result" && m.ResultValues != nil {
					n = 0
					for _, result := range m.ResultValues {
						n += measure(token[:at], result)
					}
				}
			} else {
				switch token {
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
				default:
					panic("unknown cost measure: " + token)
				}
			}
		}
		// Evaluate each rounded term exactly, then saturate the internal
		// counter. Overflow must never turn an unaffordable charge negative.
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
	for _, r := range generated.Costs.Rate {
		if r.Key == key {
			return formula(r.Fuel, m, value.Value{}), formula(r.Alloc, m, value.Value{})
		}
	}
	panic("missing Cost Model key: " + key)
}
