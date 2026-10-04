// Package shape checks Host declarations against Script values, without
// importing the Group or machine. Shapes contain immutable declaration data.
package shape

import (
	"github.com/odogono/odgn-talk/impl/go/internal/decimal"
	"github.com/odogono/odgn-talk/impl/go/internal/generated"
	"github.com/odogono/odgn-talk/impl/go/internal/value"
	"strings"
)

type Shape struct {
	Kind, Name string
	Of         []Shape
	Fields     []Field
	Open       bool
}
type Field struct {
	Key      string
	Shape    Shape
	Optional bool
}
type Mismatch struct {
	Expected, Got string
	Value         value.Value
	Path          []value.Value
	Unencodable   bool
}

func Accepts(args []Shape, n int) bool {
	if n > len(args) {
		return false
	}
	for _, s := range args[n:] {
		if s.Kind != "optional" {
			return false
		}
	}
	return true
}
func (s Shape) Expected() string {
	switch s.Kind {
	case "kind", "object", "quantity", "unitKind":
		return s.Name
	case "optional":
		return s.Of[0].Expected() + " or nothing"
	case "oneOf":
		var names []string
		for _, x := range s.Of {
			names = append(names, x.Expected())
		}
		return strings.Join(names, " or ")
	default:
		return s.Kind
	}
}
func pathKey(s string) value.Value { v, _ := value.NewText(s); return v }
func child(path []value.Value, v value.Value) []value.Value {
	out := append([]value.Value{}, path...)
	return append(out, v)
}
func DeepFunction(v value.Value, path []value.Value) *Mismatch {
	if v.Kind == value.Function {
		return &Mismatch{Expected: "any", Got: "function", Value: v, Path: path, Unencodable: true}
	}
	for i, x := range v.Items {
		if m := DeepFunction(x, child(path, value.Value{Kind: value.Number, Number: decimal.FromInt(int64(i + 1))})); m != nil {
			return m
		}
	}
	for _, p := range v.Entries {
		if m := DeepFunction(p.Val, child(path, pathKey(p.Key))); m != nil {
			return m
		}
	}
	return nil
}
func Check(v value.Value, s Shape, path []value.Value) *Mismatch {
	got := value.KindNames[v.Kind]
	if (s.Kind == "quantity" || s.Kind == "unitKind") && v.Kind == value.Quantity {
		got = v.Unit.String()
	}
	wrong := func() *Mismatch { return &Mismatch{Expected: s.Expected(), Got: got, Value: v, Path: path} }
	switch s.Kind {
	case "":
		return nil // an omitted result declaration
	case "value":
		return nil
	case "any":
		return DeepFunction(v, path)
	case "kind":
		if got == s.Name {
			return nil
		}
	case "object":
		if v.Kind == value.Object && v.Object.Kind == s.Name {
			return nil
		}
	case "quantity":
		if v.Kind == value.Quantity && v.Unit.String() == s.Name {
			return nil
		}
	case "unitKind":
		if v.Kind == value.Quantity && len(v.Unit.Slots) == 1 && v.Unit.Slots[0].Power.String() == "1" {
			if generated.Units.Unit[v.Unit.Slots[0].Unit].Kind == s.Name {
				return nil
			}
		}
	case "optional":
		if v.Kind == value.Nothing {
			return nil
		}
		m := Check(v, s.Of[0], path)
		if m != nil && len(m.Path) == len(path) && !m.Unencodable {
			m.Expected += " or nothing"
		}
		return m
	case "oneOf":
		for _, x := range s.Of {
			if Check(v, x, path) == nil {
				return nil
			}
		}
	case "list":
		if v.Kind != value.List {
			return wrong()
		}
		for i, x := range v.Items {
			if m := Check(x, s.Of[0], child(path, value.Value{Kind: value.Number, Number: decimal.FromInt(int64(i + 1))})); m != nil {
				return m
			}
		}
		return nil
	case "map":
		if v.Kind != value.Map {
			return wrong()
		}
		declared := map[string]bool{}
		for _, f := range s.Fields {
			declared[f.Key] = true
			found := false
			for _, p := range v.Entries {
				if p.Key == f.Key {
					found = true
					if m := Check(p.Val, f.Shape, child(path, pathKey(f.Key))); m != nil {
						return m
					}
					break
				}
			}
			if !found && !f.Optional {
				return &Mismatch{Expected: f.Shape.Expected(), Got: "nothing", Path: child(path, pathKey(f.Key))}
			}
		}
		for _, p := range v.Entries {
			if declared[p.Key] {
				continue
			}
			if !s.Open {
				return &Mismatch{Expected: "nothing", Got: value.KindNames[p.Val.Kind], Value: p.Val, Path: child(path, pathKey(p.Key))}
			}
			if m := DeepFunction(p.Val, child(path, pathKey(p.Key))); m != nil {
				return m
			}
		}
		return nil
	}
	return wrong()
}
