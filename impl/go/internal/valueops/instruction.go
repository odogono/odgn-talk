package valueops

import (
	"strings"

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
