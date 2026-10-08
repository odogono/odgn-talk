package northtalk

import (
	"fmt"
	"github.com/odogono/odgn-talk/impl/go/internal/docs"
	"github.com/odogono/odgn-talk/impl/go/internal/shape"
	"github.com/odogono/odgn-talk/impl/go/internal/unicode"
	v "github.com/odogono/odgn-talk/impl/go/internal/value"
	"slices"
)

func inspectionMap(pairs ...Pair) Value {
	x, err := Map(pairs...)
	if err != nil {
		panic(err)
	}
	return x
}
func inspectionText(s string) Value {
	x, err := Text(s)
	if err != nil {
		panic(err)
	}
	return x
}
func inspectionShape(s shape.Shape) Value {
	switch s.Kind {
	case "", "any":
		return inspectionText("any")
	case "value":
		return inspectionText("value")
	case "kind":
		return inspectionText(s.Name)
	case "quantity", "unitKind", "object":
		return inspectionMap(KV(s.Kind, inspectionText(s.Name)))
	case "list", "optional":
		return inspectionMap(KV(s.Kind, inspectionShape(s.Of[0])))
	case "oneOf":
		xs := []Value{}
		for _, x := range s.Of {
			xs = append(xs, inspectionShape(x))
		}
		return inspectionMap(KV("oneOf", List(xs...)))
	case "map":
		xs := []Value{}
		for _, f := range s.Fields {
			fs := []Pair{KV("key", inspectionText(f.Key)), KV("shape", inspectionShape(f.Shape))}
			if f.Optional {
				fs = append(fs, KV("optional", Bool(true)))
			}
			xs = append(xs, inspectionMap(fs...))
		}
		fs := []Pair{KV("map", List(xs...))}
		if s.Open {
			fs = append(fs, KV("open", Bool(true)))
		}
		return inspectionMap(fs...)
	}
	panic("unknown Shape")
}
func init() {
	docs.Inspection = func(raw any) ([]string, []string) {
		x := raw.(Value)
		out := []string{"value " + inspectionMap(KV("kind", inspectionText(v.KindNames[x.inner.Kind])), KV("value", x)).String()}
		size := -1
		switch x.Kind() {
		case KindText:
			bs, err := unicode.Boundaries(x.inner.Text)
			if err != nil {
				panic(err)
			}
			size = len(bs) - 1
		case KindBytes:
			size = len(x.inner.Bytes)
		case KindList:
			size = x.Len()
		case KindMap:
			size = len(x.Entries())
		}
		if size >= 0 {
			out = append(out, fmt.Sprintf("size %d", size))
		}
		if x.Kind() == KindMap {
			ps := x.Entries()
			slices.SortFunc(ps, func(a, b Pair) int {
				if a.Key < b.Key {
					return -1
				}
				if a.Key > b.Key {
					return 1
				}
				return 0
			})
			for _, p := range ps {
				out = append(out, "field "+inspectionText(p.Key).String()+" = "+p.Val.String())
			}
		}
		if x.Kind() == KindFunction {
			fn := x.inner.Function
			name := Nothing
			arity := Nothing
			if n, required, total, ok := docs.FunctionHead(x); ok {
				if n != "" {
					name = inspectionText(n)
				}
				arity, _ = Range(Int(int64(required)), Int(int64(total)))
			}
			doc, _ := docs.Function(x)
			out = append(out, "function "+inspectionMap(KV("name", name), KV("arity", arity), KV("home", inspectionText(fn.Home))).String(), "doc "+inspectionText(doc).String())
		}
		var names []string
		if o, ok := x.AsObject(); ok {
			out = append(out, "object "+inspectionMap(KV("kind", inspectionText(o.kind.name)), KV("id", inspectionText(o.id)), KV("disposed", Bool(o.disposed.Load()))).String())
			for name := range o.kind.props {
				names = append(names, name)
			}
			slices.Sort(names)
			cost := func(c Cost) Value { return inspectionMap(KV("fuel", Int(c.Fuel)), KV("alloc", Int(c.Alloc))) }
			for _, name := range names {
				p := o.kind.props[name]
				sc := Nothing
				if p.Set != nil {
					sc = cost(p.SetCost)
				}
				out = append(out, "property "+inspectionMap(KV("name", inspectionText(name)), KV("shape", inspectionShape(p.Shape.inner)), KV("readOnly", Bool(p.Set == nil)), KV("getCost", cost(p.GetCost)), KV("setCost", sc)).String())
			}
		}
		return out, names
	}
}
