package northtalk

import (
	"slices"

	"github.com/odogono/odgn-talk/impl/go/internal/machine"
	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
)

// LocaleImpl supplies Collation, case mappings, Locale data and tag fallback.
// The Grant binding is the default tag string. An omitted or Nothing tag is
// passed as ""; option maps contain every key in the documented order.
type LocaleImpl interface {
	Compare(c *Call, a, b, opts Value, tag string) (Value, error)
	Rank(c *Call, texts, opts Value, tag string) (Value, error)
	Upper(c *Call, s Value, tag string) (Value, error)
	Lower(c *Call, s Value, tag string) (Value, error)
	NumberSymbols(c *Call, tag string) (Value, error)
	MonthNames(c *Call, opts Value, tag string) (Value, error)
	DayNames(c *Call, opts Value, tag string) (Value, error)
	Tag(c *Call, tag string) (Value, error)
}

// LocaleCapability defines the eight immediate Locale Operations. The Core
// validates Shapes, options, effective tag syntax and result refinements.
// Every Host failure becomes host error; bad locale is raised only by the Core.
func (c *Core) LocaleCapability(impl LocaleImpl, costs Costs) (*CapabilityDef, error) {
	if standardImplementationMissing(impl) {
		return nil, &HostError{InvalidValue, "missing locale implementation"}
	}
	collation := MapShape(Field{Key: "sensitivity", Shape: TextShape, Optional: true}, Field{Key: "numeric", Shape: BoolShape, Optional: true})
	names := MapShape(Field{Key: "width", Shape: TextShape, Optional: true}, Field{Key: "form", Shape: TextShape, Optional: true})
	textList := ListOf(TextShape)
	symbols := MapShape(Field{Key: "decimal", Shape: TextShape}, Field{Key: "group", Shape: TextShape}, Field{Key: "minus", Shape: TextShape}, Field{Key: "digits", Shape: textList}, Field{Key: "primaryGroup", Shape: NumberShape}, Field{Key: "secondaryGroup", Shape: NumberShape}, Field{Key: "minGrouping", Shape: NumberShape})
	collationDefaults, _ := Map(KV("sensitivity", Value{mustText("variant")}), KV("numeric", Bool(false)))
	nameDefaults, _ := Map(KV("width", Value{mustText("long")}), KV("form", Value{mustText("format")}))
	checks := map[string]operationChecks{}
	var ops []Operation
	add := func(name string, args []Shape, result Shape, defaults Value, do func(*Call, []Value, Value, string) (Value, error), resultCheck func(corevalue.Value, []corevalue.Value) bool) error {
		cost, err := standardCost(costs, name)
		if err != nil {
			return err
		}
		required := len(args)
		options := defaults.Kind() == KindMap
		if options {
			optionShape := names
			if name == "compare" || name == "rank" {
				optionShape = collation
			}
			args = append(args, Optional(OneOf(optionShape, TextShape)))
		}
		args = append(args, Optional(TextShape))
		ops = append(ops, Operation{Name: name, Mode: Immediate, Args: args, Result: result, Cost: cost, Errors: []ErrorDecl{}, Do: func(call *Call, values []Value) (Value, error) {
			given, tag := localeParts(values, required, options)
			return do(call, values, localeDefaults(given, defaults), tag)
		}})
		checks[name] = operationChecks{arguments: localeArguments(name, required, options), result: resultCheck}
		return nil
	}
	// Each row fixes its required arguments, result Shape and Host dispatch.
	for _, row := range []struct {
		name     string
		args     []Shape
		result   Shape
		defaults Value
		do       func(*Call, []Value, Value, string) (Value, error)
		check    func(corevalue.Value, []corevalue.Value) bool
	}{
		{"compare", []Shape{TextShape, TextShape}, NumberShape, collationDefaults, func(c *Call, a []Value, o Value, t string) (Value, error) { return impl.Compare(c, a[0], a[1], o, t) }, localeCompareResult},
		{"rank", []Shape{textList}, OpenMap(), collationDefaults, func(c *Call, a []Value, o Value, t string) (Value, error) { return impl.Rank(c, a[0], o, t) }, localeRankResult},
		{"upper", []Shape{TextShape}, TextShape, Nothing, func(c *Call, a []Value, _ Value, t string) (Value, error) { return impl.Upper(c, a[0], t) }, nil},
		{"lower", []Shape{TextShape}, TextShape, Nothing, func(c *Call, a []Value, _ Value, t string) (Value, error) { return impl.Lower(c, a[0], t) }, nil},
		{"numberSymbols", nil, symbols, Nothing, func(c *Call, _ []Value, _ Value, t string) (Value, error) { return impl.NumberSymbols(c, t) }, localeSymbolsResult},
		{"monthNames", nil, textList, nameDefaults, func(c *Call, _ []Value, o Value, t string) (Value, error) { return impl.MonthNames(c, o, t) }, func(v corevalue.Value, _ []corevalue.Value) bool { return len(v.Items()) == 12 }},
		{"dayNames", nil, textList, nameDefaults, func(c *Call, _ []Value, o Value, t string) (Value, error) { return impl.DayNames(c, o, t) }, func(v corevalue.Value, _ []corevalue.Value) bool { return len(v.Items()) == 7 }},
		{"tag", nil, TextShape, Nothing, func(c *Call, _ []Value, _ Value, t string) (Value, error) { return impl.Tag(c, t) }, func(v corevalue.Value, _ []corevalue.Value) bool { return wellFormedLocale(v.Text()) }},
	} {
		if err := add(row.name, row.args, row.result, row.defaults, row.do, row.check); err != nil {
			return nil, err
		}
	}
	def, err := c.DefineCapability("locale", ops...)
	if err != nil {
		return nil, err
	}
	def.checks = checks
	return def, nil
}

func localeParts(args []Value, required int, options bool) (given Value, tag string) {
	if required >= len(args) {
		return Nothing, ""
	}
	first := args[required]
	tagIndex := required
	if options && first.Kind() != KindText {
		given = first
		tagIndex++
	}
	if tagIndex < len(args) {
		tag, _ = args[tagIndex].AsText()
	}
	return given, tag
}
func localeDefaults(given, defaults Value) Value {
	if defaults.Kind() != KindMap {
		return Nothing
	}
	pairs := defaults.Entries()
	for i := range pairs {
		if value := given.Get(pairs[i].Key); value.Kind() != KindNothing {
			pairs[i].Val = value
		}
	}
	v, _ := Map(pairs...)
	return v
}
func localeArguments(name string, required int, options bool) func([]corevalue.Value, any, []corevalue.Pair) *corevalue.Value {
	return func(args []corevalue.Value, binding any, _ []corevalue.Pair) *corevalue.Value {
		domain := func(value corevalue.Value) *corevalue.Value {
			err := machine.ErrorValue("out of domain", corevalue.Pair{Key: "function", Val: mustText(name)}, corevalue.Pair{Key: "value", Val: value})
			return &err
		}
		tagIndex := required
		if options && len(args) > required {
			first := args[required]
			if first.Kind == corevalue.Text {
				if len(args) > required+1 {
					return domain(first)
				}
			} else {
				tagIndex++
				for _, p := range first.Entries() {
					var words []string
					switch p.Key {
					case "sensitivity":
						words = []string{"base", "accent", "case", "variant"}
					case "width":
						words = []string{"long", "short", "narrow"}
					case "form":
						words = []string{"format", "standalone"}
					}
					if words != nil && !slices.Contains(words, p.Val.Text()) {
						return domain(p.Val)
					}
				}
			}
		}
		tag, _ := binding.(string)
		if tagIndex < len(args) && args[tagIndex].Kind == corevalue.Text {
			tag = args[tagIndex].Text()
		}
		if !wellFormedLocale(tag) {
			err := machine.ErrorValue("bad locale", corevalue.Pair{Key: "locale", Val: mustText(tag)})
			return &err
		}
		return nil
	}
}
func localeCompareResult(v corevalue.Value, _ []corevalue.Value) bool {
	n, err := v.Number().Int64()
	return err == nil && n >= -1 && n <= 1
}
func localeRankResult(v corevalue.Value, args []corevalue.Value) bool {
	wanted := map[string]bool{}
	for _, text := range args[0].Items() {
		wanted[text.Text()] = true
	}
	if len(v.Entries()) != len(wanted) {
		return false
	}
	ranks := map[int64]bool{}
	for _, p := range v.Entries() {
		if !wanted[p.Key] || p.Val.Kind != corevalue.Number {
			return false
		}
		n, err := p.Val.Number().Int64()
		if err != nil || n < 1 || n > int64(len(wanted)) {
			return false
		}
		ranks[n] = true
	}
	for i := int64(1); i <= int64(len(ranks)); i++ {
		if !ranks[i] {
			return false
		}
	}
	return true
}
func localeSymbolsResult(v corevalue.Value, _ []corevalue.Value) bool {
	for _, key := range []string{"decimal", "group", "minus"} {
		if v.Get(key).Text() == "" {
			return false
		}
	}
	digits := v.Get("digits")
	if len(digits.Items()) != 10 {
		return false
	}
	for _, digit := range digits.Items() {
		if digit.Text() == "" {
			return false
		}
	}
	for _, key := range []string{"primaryGroup", "secondaryGroup", "minGrouping"} {
		n, ok := v.Get(key).Number().Integer()
		if !ok || n.Sign() <= 0 {
			return false
		}
	}
	return true
}
