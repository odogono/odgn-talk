package session

import (
	"encoding/json"
	talk "github.com/odogono/odgn-talk/impl/go"
	"github.com/odogono/odgn-talk/impl/go/internal/sessionio"
)

func decodeEnvelopeCost(raw []byte) talk.Cost {
	e := envelopeObject(raw)
	envelopeFields(e, []string{"fuel", "alloc"})
	var c talk.Cost
	if json.Unmarshal(e["fuel"], &c.Fuel) != nil || json.Unmarshal(e["alloc"], &c.Alloc) != nil || c.Fuel < 0 || c.Alloc < 0 || c.Fuel >= 9007199254740992 || c.Alloc >= 9007199254740992 {
		envelopeError("invalid cost")
	}
	return c
}
func decodeEnvelopeShape(raw []byte) talk.Shape {
	if len(raw) > 0 && raw[0] == '"' {
		s := envelopeText(raw)
		switch s {
		case "any":
			return talk.AnyShape
		case "value":
			return talk.ValueShape
		case "nothing":
			return talk.NothingShape
		case "boolean":
			return talk.BoolShape
		case "number":
			return talk.NumberShape
		case "text":
			return talk.TextShape
		case "bytes":
			return talk.BytesShape
		case "instant":
			return talk.InstantShape
		case "civil date":
			return talk.CivilDateShape
		case "range":
			return talk.RangeShape
		case "pattern":
			return talk.PatternShape
		case "function":
			return talk.FunctionShape
		}
		envelopeError("invalid scalar Shape")
	}
	e := envelopeObject(raw)
	if len(e) == 1 {
		for k, x := range e {
			switch k {
			case "quantity":
				return talk.QuantityOf(envelopeText(x))
			case "unitKind":
				return talk.QuantityKind(envelopeText(x))
			case "object":
				return objectShape(envelopeText(x))
			case "list":
				return talk.ListOf(decodeEnvelopeShape(x))
			case "optional":
				return talk.Optional(decodeEnvelopeShape(x))
			case "oneOf":
				var xs []json.RawMessage
				if json.Unmarshal(x, &xs) != nil {
					envelopeError("invalid oneOf")
				}
				ss := []talk.Shape{}
				for _, s := range xs {
					ss = append(ss, decodeEnvelopeShape(s))
				}
				return talk.OneOf(ss...)
			}
		}
	}
	envelopeFields(e, []string{"map"}, "open")
	var fs []Envelope
	if json.Unmarshal(e["map"], &fs) != nil || fs == nil {
		envelopeError("invalid map Shape")
	}
	fields := []talk.Field{}
	seen := map[string]bool{}
	for _, f := range fs {
		envelopeFields(f, []string{"key", "shape"}, "optional")
		key := envelopeText(f["key"])
		if seen[key] {
			envelopeError("duplicate Shape field")
		}
		seen[key] = true
		optional := false
		if x, ok := f["optional"]; ok {
			optional = envelopeBool(x)
			if !optional {
				envelopeError("invalid optional")
			}
		}
		fields = append(fields, talk.Field{Key: key, Shape: decodeEnvelopeShape(f["shape"]), Optional: optional})
	}
	if x, ok := e["open"]; ok {
		if !envelopeBool(x) {
			envelopeError("invalid open")
		}
		return talk.OpenMap(fields...)
	}
	return talk.MapShape(fields...)
}

func objectShape(name string) talk.Shape { return sessionio.ObjectShape(name).(talk.Shape) }
