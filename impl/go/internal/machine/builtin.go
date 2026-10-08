package machine

import (
	coreunicode "github.com/odogono/odgn-talk/impl/go/internal/unicode"
	"unicode/utf8"

	"github.com/odogono/odgn-talk/impl/go/internal/value"
)

func builtin(name string, args []value.Value, m *Measures) (value.Value, *value.Value) {
	bad := func(expected string, v value.Value) (value.Value, *value.Value) {
		e := wrong(expected, v)
		return value.Value{}, &e
	}
	domain := func(v value.Value) (value.Value, *value.Value) {
		e := failure("out of domain", value.Pair{Key: "function", Val: text(name)}, value.Pair{Key: "value", Val: v})
		return value.Value{}, &e
	}
	v := value.Value{}
	if len(args) > 0 {
		v = args[0]
	}
	switch name {
	case "upper", "lower":
		if v.Kind != value.Text {
			return bad("text", v)
		}
		out, _ := coreunicode.Case(v.Text, name == "upper")
		return text(out), nil
	case "floor", "ceiling", "truncate", "round", "sqrt", "exp", "ln", "log10", "power", "sin", "cos", "tan", "asin", "acos", "atan", "atan2", "fromFloat64", "fromFloat32", "toFloat64", "toFloat32":
		return builtinNumber(name, args)
	case "year", "month", "day", "hour", "minute", "second", "nanosecond", "weekday", "dayOfYear", "isoWeek", "isoWeekYear", "hasTime", "toCivil", "toInstant":
		return builtinDate(name, args)

	case "fromCodePoint":
		if v.Kind != value.Number {
			return bad("number", v)
		}
		n, e := v.Number.Int64()
		if e != nil {
			return domain(v)
		}
		if n < 0 || n > utf8.MaxRune || n >= 0xd800 && n <= 0xdfff {
			return domain(v)
		}
		return text(string(rune(n))), nil
	case "codePoint":
		if v.Kind != value.Text {
			return bad("text", v)
		}
		if utf8.RuneCountInString(v.Text) != 1 {
			return domain(v)
		}
		cp, _ := utf8.DecodeRuneInString(v.Text)
		return integer(int64(cp)), nil
	case "offset":
		if len(args) < 2 {
			return bad("text", value.Value{})
		}
		subject := args[1]
		if subject.Kind != value.Text {
			return bad("text", subject)
		}
		p, e := compilePattern(v, false)
		if e != nil {
			return bad("pattern", v)
		}
		match, steps := search(p, subject.Text, 0, "search", false)
		m.Steps = steps
		if match == nil {
			return integer(0), nil
		}
		return integer(int64(match.Start + 1)), nil
	case "kindOf":
		return text(value.KindNames[v.Kind]), nil
	case "objectKind", "isDisposed":
		if v.Kind != value.Object {
			return bad("object", v)
		}
		if name == "objectKind" {
			return text(v.Object.Kind), nil
		}
		return boolean(v.Object.Disposed != nil && v.Object.Disposed.Load()), nil
	case "rangeStart", "rangeEnd":
		if v.Kind != value.Range {
			return bad("range", v)
		}
		if name == "rangeStart" {
			return v.Items[0], nil
		}
		return v.Items[1], nil
	case "functionArity", "functionName":
		if v.Kind != value.Function {
			return bad("function", v)
		}
		if name == "functionName" {
			if v.Function.Name == "" {
				return value.Value{}, nil
			}
			return text(v.Function.Name), nil
		}
		result, _ := value.NewRange(integer(int64(v.Function.Required)), integer(int64(v.Function.Total)))
		return result, nil
	case "abs":
		if v.Kind != value.Number && v.Kind != value.Quantity {
			return bad("number or quantity", v)
		}
		if v.Number.Sign() < 0 {
			v.Number = v.Number.Negate()
		}
		return v, nil
	case "min", "max":
		if v.Kind != value.List {
			return bad("list", v)
		}
		if len(v.Items) == 0 {
			return domain(v)
		}
		out := v.Items[0]
		for _, x := range v.Items[1:] {
			m.Scanned++
			c, e := x.Compare(out)
			if e != nil {
				err := failure("can't compare", value.Pair{Key: "left", Val: x}, value.Pair{Key: "right", Val: out})
				return value.Value{}, &err
			}
			if name == "min" && c < 0 || name == "max" && c > 0 {
				out = x
			}
		}
		return out, nil
	}
	e := failure("host error", value.Pair{Key: "operation", Val: text("unsupported builtin " + name)})
	return value.Value{}, &e
}
