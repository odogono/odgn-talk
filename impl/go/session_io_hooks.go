package northtalk

import (
	"encoding/json"
	"fmt"

	"northtalk.org/go/internal/sessionio"
	v "northtalk.org/go/internal/value"
)

func init() {
	sessionio.Shape = func(raw any) any {
		b, err := json.Marshal(shapeData(raw.(Shape).inner))
		if err != nil {
			panic(err)
		}
		return json.RawMessage(b)
	}
	sessionio.ObjectShape = func(name string) any { return ObjectShape(&ObjectKind{name: name}) }
	sessionio.Decode = func(bytes []byte, object func(string, string) (any, bool), function func(string) (any, bool)) (any, error) {
		x, err := v.DecodeWithFunctions(bytes, true, func(kind, id string) (v.Value, error) {
			raw, ok := object(kind, id)
			if !ok {
				return v.Value{}, fmt.Errorf("unknown object")
			}
			return raw.(*Object).Value().inner, nil
		}, func(h string) (v.Value, error) {
			raw, ok := function(h)
			if !ok {
				return v.Value{}, fmt.Errorf("unresolved function")
			}
			return raw.(Value).inner, nil
		})
		return Value{x}, err
	}
}
