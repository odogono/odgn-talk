package machine

import (
	"encoding/binary"
	"github.com/odogono/odgn-talk/impl/go/internal/decimal"
	"github.com/odogono/odgn-talk/impl/go/internal/value"
	"math"
	"strconv"
)

func builtinNumber(name string, args []value.Value) (value.Value, *value.Value) {
	v := args[0]
	fail := func(e value.Value) (value.Value, *value.Value) { return value.Value{}, &e }
	domain := func(x value.Value) (value.Value, *value.Value) {
		return fail(failure("out of domain", value.Pair{Key: "function", Val: text(name)}, value.Pair{Key: "value", Val: x}))
	}
	numeric := func(n decimal.Number, e *decimal.Error) (value.Value, *value.Value) {
		if e != nil {
			if e.Code == "out of domain" {
				return domain(v)
			}
			if e.Code == "overflow" {
				return fail(failure(e.Code, value.Pair{Key: "operator", Val: text(name)}))
			}
			return fail(failure(e.Code))
		}
		v = v.WithNumber(n)
		return v, nil
	}
	switch name {
	case "floor", "ceiling", "truncate", "round":
		if v.Kind != value.Number && v.Kind != value.Quantity {
			return fail(wrong("number or quantity", v))
		}
		places, mode := 0, name
		if name == "truncate" {
			mode = "down"
		}
		if name == "round" {
			mode = "half up"
			if len(args) > 1 {
				p := args[1]
				if p.Kind != value.Number {
					return fail(wrong("number", p))
				}
				n, ok := p.Number().Integer()
				if !ok || n.Sign() < 0 {
					return domain(p)
				}
				if !n.IsInt64() || n.Int64() > -decimal.MinExponent {
					return fail(failure("overflow", value.Pair{Key: "operator", Val: text(name)}))
				}
				places = int(n.Int64())
			}
			if len(args) > 2 {
				p := args[2]
				if p.Kind != value.Text {
					return fail(wrong("text", p))
				}
				mode = p.Text()
				switch mode {
				case "half up", "half even", "up", "down", "floor", "ceiling":
				default:
					return domain(p)
				}
			}
		}
		n, e := decimal.Integral(v.Number(), places, mode, name)
		return numeric(n, e)
	case "sqrt", "exp", "ln", "log10", "power", "sin", "cos", "tan", "asin", "acos", "atan", "atan2":
		if v.Kind != value.Number {
			return fail(wrong("number", v))
		}
		y := decimal.FromInt(0)
		if len(args) > 1 {
			if args[1].Kind != value.Number {
				return fail(wrong("number", args[1]))
			}
			y = args[1].Number()
		}
		if name == "power" {
			n, e := decimal.Calculate("^", v.Number(), y)
			return numeric(n, e)
		}
		n, e := decimal.Function(name, v.Number(), y)
		return numeric(n, e)
	}
	order := binary.ByteOrder(binary.BigEndian)
	if len(args) > 1 {
		if args[1].Kind != value.Text {
			return fail(wrong("text", args[1]))
		}
		switch args[1].Text() {
		case "big":
		case "little":
			order = binary.LittleEndian
		default:
			return domain(args[1])
		}
	}
	bits := 64
	if name == "fromFloat32" || name == "toFloat32" {
		bits = 32
	}
	if name == "fromFloat64" || name == "fromFloat32" {
		if v.Kind != value.Bytes {
			return fail(wrong("bytes", v))
		}
		if len(v.Bytes()) != bits/8 {
			return domain(v)
		}
		var f float64
		if bits == 32 {
			f = float64(math.Float32frombits(order.Uint32(v.Bytes())))
		} else {
			f = math.Float64frombits(order.Uint64(v.Bytes()))
		}
		if math.IsNaN(f) || math.IsInf(f, 0) || math.Abs(f) >= 1e34 {
			return fail(failure("can't convert", value.Pair{Key: "value", Val: v}, value.Pair{Key: "to", Val: text("number")}))
		}
		if f == 0 {
			return integer(0), nil
		}
		n, e := decimal.ParseJSON(strconv.FormatFloat(f, 'g', -1, bits))
		if e != nil {
			return fail(failure("can't convert", value.Pair{Key: "value", Val: v}, value.Pair{Key: "to", Val: text("number")}))
		}
		return value.Fields{Kind: value.Number, Number: n}.Value(), nil
	}
	if v.Kind != value.Number {
		return fail(wrong("number", v))
	}
	b := make([]byte, bits/8)
	if bits == 32 {
		f, _ := v.Number().Rat().Float32()
		order.PutUint32(b, math.Float32bits(f))
	} else {
		f, _ := v.Number().Rat().Float64()
		order.PutUint64(b, math.Float64bits(f))
	}
	return value.NewBytes(b), nil
}
