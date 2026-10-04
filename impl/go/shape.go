package northtalk

import (
	"github.com/odogono/odgn-talk/impl/go/internal/shape"
	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
)

type Shape struct{ inner shape.Shape }
type Field struct {
	Key      string
	Shape    Shape
	Optional bool
}

var (
	AnyShape       Shape = Shape{shape.Shape{Kind: "any"}}
	ValueShape     Shape = Shape{shape.Shape{Kind: "value"}}
	NothingShape   Shape = kindShape("nothing")
	BoolShape      Shape = kindShape("boolean")
	NumberShape    Shape = kindShape("number")
	TextShape      Shape = kindShape("text")
	BytesShape     Shape = kindShape("bytes")
	InstantShape   Shape = kindShape("instant")
	RangeShape     Shape = kindShape("range")
	CivilDateShape Shape = kindShape("civil date")
	PatternShape   Shape = kindShape("pattern")
	FunctionShape  Shape = kindShape("function")
)

func kindShape(name string) Shape { return Shape{shape.Shape{Kind: "kind", Name: name}} }
func QuantityOf(unit string) Shape {
	u, e := corevalue.ParseUnit(unit)
	if e != nil {
		panic(&HostError{InvalidValue, e.Error()})
	}
	return Shape{shape.Shape{Kind: "quantity", Name: u.String()}}
}
func QuantityKind(kind string) Shape { return Shape{shape.Shape{Kind: "unitKind", Name: kind}} }
func ListOf(s Shape) Shape           { return Shape{shape.Shape{Kind: "list", Of: []shape.Shape{s.inner}}} }
func Optional(s Shape) Shape         { return Shape{shape.Shape{Kind: "optional", Of: []shape.Shape{s.inner}}} }
func OneOf(ss ...Shape) Shape {
	out := shape.Shape{Kind: "oneOf"}
	for _, s := range ss {
		out.Of = append(out.Of, s.inner)
	}
	return Shape{out}
}
func MapShape(fields ...Field) Shape { return mapShape(false, fields) }
func OpenMap(fields ...Field) Shape  { return mapShape(true, fields) }
func mapShape(open bool, fields []Field) Shape {
	out := shape.Shape{Kind: "map", Open: open}
	for _, f := range fields {
		out.Fields = append(out.Fields, shape.Field{Key: f.Key, Shape: f.Shape.inner, Optional: f.Optional})
	}
	return Shape{out}
}
func ObjectShape(kind *ObjectKind) Shape {
	if kind == nil {
		panic(&HostError{InvalidValue, "nil Object Kind"})
	}
	return Shape{shape.Shape{Kind: "object", Name: kind.name}}
}
