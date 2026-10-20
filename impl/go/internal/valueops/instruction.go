package valueops

import (
	"strings"

	"github.com/odogono/odgn-talk/impl/go/internal/decimal"
	"github.com/odogono/odgn-talk/impl/go/internal/generated"
	"github.com/odogono/odgn-talk/impl/go/internal/value"
)

func text(s string) value.Value { v, _ := value.NewText(s); return v }
func failure(code string, fields ...value.Pair) value.Value {
	message := code
	for _, entry := range generated.Errors.Error {
		if entry.Code != code {
			continue
		}
		message = entry.Message
		var replacements []string
		for _, field := range fields {
			replacements = append(replacements, "{"+field.Key+"}", field.Val.Display())
		}
		if len(replacements) > 0 {
			message = strings.NewReplacer(replacements...).Replace(message)
		}
		break
	}
	v, _ := value.NewMap(append([]value.Pair{{Key: "code", Val: text(code)}, {Key: "message", Val: text(message)}}, fields...))
	v.CoreMessage = true
	return v
}
func wrong(expected string, v value.Value) value.Value {
	return failure("wrong kind", value.Pair{Key: "expected", Val: text(expected)}, value.Pair{Key: "got", Val: text(value.KindNames[v.Kind])}, value.Pair{Key: "value", Val: v})
}
func constant(s string) (value.Value, error) {
	switch s {
	case "newline":
		return text("\n"), nil
	case "tab":
		return text("\t"), nil
	case "quote":
		return text("\""), nil
	case "space":
		return text(" "), nil
	case "empty":
		return text(""), nil
	case "pi":
		n, _ := decimal.Parse("3.141592653589793238462643383279503")
		return value.Fields{Kind: value.Number, Number: n}.Value(), nil
	}
	if strings.HasPrefix(s, "<") && !strings.HasPrefix(s, "<<") {
		return value.Fields{Kind: value.Pattern, Text: s}.Value(), nil
	}
	r := value.Reader{Text: s}
	v, e := r.Value()
	if e != nil {
		return v, e
	}
	return v, nil
}
