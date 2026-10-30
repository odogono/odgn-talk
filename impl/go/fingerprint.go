package northtalk

import (
	"northtalk.org/go/internal/shape"
)

func shapeData(s shape.Shape) any {
	switch s.Kind {
	case "", "any", "value":
		return s.Kind
	case "kind":
		return s.Name
	case "object", "quantity", "unitKind":
		return map[string]any{s.Kind: s.Name}
	case "optional", "list":
		return map[string]any{s.Kind: shapeData(s.Of[0])}
	case "oneOf":
		xs := []any{}
		for _, x := range s.Of {
			xs = append(xs, shapeData(x))
		}
		return map[string]any{"oneOf": xs}
	case "map":
		return struct {
			Map  []fieldData `json:"map"`
			Open bool        `json:"open,omitempty"`
		}{fieldsData(s.Fields), s.Open}
	}
	panic("unknown Shape")
}

type fieldData struct {
	Key      string `json:"key"`
	Shape    any    `json:"shape"`
	Optional bool   `json:"optional,omitempty"`
}

func fieldsData(fs []shape.Field) []fieldData {
	out := []fieldData{}
	for _, f := range fs {
		out = append(out, fieldData{f.Key, shapeData(f.Shape), f.Optional})
	}
	return out
}

func cmpString(a, b string) int {
	if a < b {
		return -1
	}
	if a > b {
		return 1
	}
	return 0
}

// Fingerprint covers declarations, code identities and limits, never state.
func (g *Group) Fingerprint() [32]byte {
	return g.backend.fingerprint()
}
