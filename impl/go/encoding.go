package northtalk

import (
	"errors"
	"fmt"

	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
)

type ScriptError struct {
	Code    string
	Message string
	Data    Value
}

func (e *ScriptError) Error() string { return e.Code + ": " + e.Message }
func encode(v Value, plain bool) ([]byte, error) {
	b, e := corevalue.Encode(v.inner, plain)
	if e == nil {
		return b, nil
	}
	var refusal *corevalue.EncodingError
	if errors.As(e, &refusal) {
		items := make([]Value, len(refusal.Path))
		for i, p := range refusal.Path {
			items[i] = Value{p}
		}
		kind, _ := Text(corevalue.KindNames[refusal.Kind])
		data, _ := Map(KV("kind", kind), KV("path", List(items...)))
		return nil, &ScriptError{"not encodable", e.Error(), data}
	}
	return nil, &HostError{InvalidValue, e.Error()}
}
func EncodeJSON(v Value) ([]byte, error)  { return encode(v, true) }
func EncodeValue(v Value) ([]byte, error) { return encode(v, false) }
func DecodeJSON(b []byte) (Value, error)  { return hostValue(corevalue.Decode(b, false, nil)) }
func DecodeValue(b []byte, resolve func(kind, id string) (*Object, bool)) (Value, error) {
	var resolver func(string, string) (corevalue.Value, error)
	if resolve != nil {
		resolver = func(kind, id string) (corevalue.Value, error) {
			o, ok := resolve(kind, id)
			if !ok || o == nil || o.kind == nil {
				return corevalue.Value{}, fmt.Errorf("object not resolved")
			}
			return o.Value().inner, nil
		}
	}
	return hostValue(corevalue.Decode(b, true, resolver))
}
