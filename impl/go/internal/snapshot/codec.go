// Package snapshot encodes plain machine data and explicitly named external
// references. It never serializes native handles, Host code or synchronization.
package snapshot

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math/big"
	"reflect"
	"slices"
	"strings"
	"time"

	"github.com/odogono/odgn-talk/impl/go/internal/decimal"
	"github.com/odogono/odgn-talk/impl/go/internal/generated"
	"github.com/odogono/odgn-talk/impl/go/internal/value"
)

type Codec struct {
	ValueType   reflect.Type
	UnwrapValue func(any) value.Value
	WrapValue   func(value.Value) any

	Reference func(any) (string, bool)
	Resolve   func(string) (any, bool)
	Object    func(kind, id string) (value.Value, error)
	Function  func(*value.FunctionData) error
}

var valueType = reflect.TypeFor[value.Value]()
var unitType = reflect.TypeFor[value.Unit]()
var numberType = reflect.TypeFor[decimal.Number]()
var objectType = reflect.TypeFor[*value.ObjectData]()
var timeType = reflect.TypeFor[time.Time]()
var bigType = reflect.TypeFor[big.Int]()

func (c Codec) Marshal(v any) ([]byte, error) {
	data, err := c.encode(reflect.ValueOf(v))
	if err != nil {
		return nil, err
	}
	return json.Marshal(data)
}
func (c Codec) Unmarshal(data []byte, out any) error {
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	var v any
	if err := d.Decode(&v); err != nil {
		return err
	}
	target := reflect.ValueOf(out)
	if target.Kind() != reflect.Pointer || target.IsNil() {
		return fmt.Errorf("snapshot needs a destination")
	}
	return c.decode(v, target.Elem())
}
func (c Codec) encode(v reflect.Value) (any, error) {
	if !v.IsValid() {
		return nil, nil
	}
	if v.Kind() == reflect.Interface {
		if v.IsNil() {
			return nil, nil
		}
		return c.encode(v.Elem())
	}
	if (v.Kind() == reflect.Pointer || v.Kind() == reflect.Slice || v.Kind() == reflect.Map) && v.IsNil() {
		return nil, nil
	}
	if v.Type() == c.ValueType {
		return c.encode(reflect.ValueOf(c.UnwrapValue(v.Interface())))
	}
	if c.Reference != nil {
		if ref, ok := c.Reference(v.Interface()); ok {
			return map[string]any{"$ref": ref}, nil
		}
	}
	if v.Type() == objectType {
		o := v.Interface().(*value.ObjectData)
		return map[string]any{"kind": o.Kind, "id": o.ID}, nil
	}
	if v.Type() == numberType {
		return v.Interface().(decimal.Number).Snapshot(), nil
	}
	if v.Type() == timeType {
		return v.Interface().(time.Time).Format(time.RFC3339Nano), nil
	}
	if v.Type() == bigType {
		n := v.Interface().(big.Int)
		return n.String(), nil
	}
	switch v.Kind() {
	case reflect.Pointer:
		return c.encode(v.Elem())
	case reflect.Struct:
		out := map[string]any{}
		for i := 0; i < v.NumField(); i++ {
			f := v.Type().Field(i)
			if !f.IsExported() {
				continue
			}
			x, err := c.encode(v.Field(i))
			if err != nil {
				return nil, err
			}
			out[f.Name] = x
		}
		return out, nil
	case reflect.Map:
		out := map[string]any{}
		keys := v.MapKeys()
		slices.SortFunc(keys, func(a, b reflect.Value) int {
			return strings.Compare(fmt.Sprint(a.Interface()), fmt.Sprint(b.Interface()))
		})
		for _, k := range keys {
			key := fmt.Sprint(k.Interface())
			x, err := c.encode(v.MapIndex(k))
			if err != nil {
				return nil, err
			}
			out[key] = x
		}
		return out, nil
	case reflect.Array, reflect.Slice:
		out := make([]any, v.Len())
		for i := range out {
			x, err := c.encode(v.Index(i))
			if err != nil {
				return nil, err
			}
			out[i] = x
		}
		return out, nil
	case reflect.Bool:
		return v.Bool(), nil
	case reflect.String:
		return v.String(), nil
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return v.Int(), nil
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return v.Uint(), nil
	default:
		return nil, fmt.Errorf("executable or unsupported snapshot field %s", v.Type())
	}
}
func (c Codec) decode(data any, v reflect.Value) error {
	if data == nil {
		switch v.Kind() {
		case reflect.Pointer, reflect.Map, reflect.Slice, reflect.Interface:
		default:
			return fmt.Errorf("null %s", v.Type())
		}
		v.SetZero()
		return nil
	}
	if m, ok := data.(map[string]any); ok {
		if key, ok := m["$ref"].(string); ok {
			if c.Resolve == nil {
				return fmt.Errorf("unknown reference %s", key)
			}
			x, ok := c.Resolve(key)
			if !ok {
				return fmt.Errorf("unknown reference %s", key)
			}
			r := reflect.ValueOf(x)
			if !r.Type().AssignableTo(v.Type()) {
				return fmt.Errorf("invalid reference %s", key)
			}
			v.Set(r)
			return nil
		}
	}
	if v.Type() == c.ValueType {
		var x value.Value
		if err := c.decode(data, reflect.ValueOf(&x).Elem()); err != nil {
			return err
		}
		v.Set(reflect.ValueOf(c.WrapValue(x)))
		return nil
	}
	if v.Type() == objectType {
		m, ok := data.(map[string]any)
		if !ok || c.Object == nil {
			return fmt.Errorf("invalid Object")
		}
		kind, k := m["kind"].(string)
		id, i := m["id"].(string)
		if !k || !i {
			return fmt.Errorf("invalid Object")
		}
		x, err := c.Object(kind, id)
		if err != nil {
			return err
		}
		v.Set(reflect.ValueOf(x.Object))
		return nil
	}
	if v.Type() == numberType {
		m, ok := data.(string)
		if !ok {
			return fmt.Errorf("invalid decimal")
		}
		x, err := decimal.RestoreSnapshot(m)
		if err != nil {
			return err
		}
		v.Set(reflect.ValueOf(x))
		return nil
	}
	if v.Type() == timeType {
		s, ok := data.(string)
		if !ok {
			return fmt.Errorf("invalid Clock")
		}
		t, err := time.Parse(time.RFC3339Nano, s)
		if err != nil {
			return err
		}
		v.Set(reflect.ValueOf(t))
		return nil
	}
	if v.Type() == bigType {
		s, ok := data.(string)
		if !ok {
			return fmt.Errorf("invalid integer")
		}
		n, ok := new(big.Int).SetString(s, 10)
		if !ok {
			return fmt.Errorf("invalid integer")
		}
		v.Set(reflect.ValueOf(*n))
		return nil
	}
	switch v.Kind() {
	case reflect.Pointer:
		v.Set(reflect.New(v.Type().Elem()))
		return c.decode(data, v.Elem())
	case reflect.Struct:
		m, ok := data.(map[string]any)
		if !ok {
			return fmt.Errorf("invalid %s", v.Type())
		}
		for i := 0; i < v.NumField(); i++ {
			f := v.Type().Field(i)
			if !f.IsExported() {
				continue
			}
			x, ok := m[f.Name]
			if !ok {
				return fmt.Errorf("missing %s.%s", v.Type(), f.Name)
			}
			if err := c.decode(x, v.Field(i)); err != nil {
				return fmt.Errorf("%s: %w", f.Name, err)
			}
		}

		if v.Type() == unitType {
			unit := v.Interface().(value.Unit)
			for _, slot := range unit.Slots {
				if slot.Unit < 0 || slot.Unit >= len(generated.Units.Unit) || slot.Power == nil || slot.Power.Sign() == 0 {
					return fmt.Errorf("invalid unit slot")
				}
			}
			if len(unit.Slots) > 0 {
				normal, err := value.ParseUnit(unit.String())
				if err != nil || len(normal.Slots) != len(unit.Slots) {
					return fmt.Errorf("invalid unit")
				}
				for i, slot := range normal.Slots {
					if slot.Unit != unit.Slots[i].Unit || slot.Power.Cmp(unit.Slots[i].Power) != 0 {
						return fmt.Errorf("noncanonical unit")
					}
				}
			}
		}
		if v.Type() == valueType {
			x := v.Interface().(value.Value)
			if x.Kind < value.Nothing || x.Kind > value.Replacement {
				return fmt.Errorf("invalid Value kind")
			}
			if x.Kind == value.Function && x.Function == nil || x.Kind == value.Object && x.Object == nil {
				return fmt.Errorf("missing Value metadata")
			}
			if x.Kind == value.Function && c.Function != nil {
				if err := c.Function(x.Function); err != nil {
					return err
				}
			}
			if x.Kind == value.Range {
				if len(x.Items) != 2 {
					return fmt.Errorf("invalid Range")
				}
				if _, err := value.NewRange(x.Items[0], x.Items[1]); err != nil {
					return err
				}
			}
			if x.Kind == value.Quantity && len(x.Unit.Slots) == 0 {
				return fmt.Errorf("dimensionless Quantity")
			}
			if x.Kind == value.Iterator && x.Iterator == nil || x.Kind == value.BinaryReader && x.Reader == nil || x.Kind == value.Replacement && x.Replacement == nil {
				return fmt.Errorf("missing internal Value state")
			}
		}
		return nil
	case reflect.Map:
		m, ok := data.(map[string]any)
		if !ok {
			return fmt.Errorf("invalid map")
		}
		v.Set(reflect.MakeMap(v.Type()))
		for key, x := range m {
			k := reflect.New(v.Type().Key()).Elem()
			if k.Kind() == reflect.String {
				k.SetString(key)
			} else {
				if err := c.decode(json.Number(key), k); err != nil {
					return err
				}
			}
			val := reflect.New(v.Type().Elem()).Elem()
			if err := c.decode(x, val); err != nil {
				return err
			}
			v.SetMapIndex(k, val)
		}
		return nil
	case reflect.Array, reflect.Slice:
		xs, ok := data.([]any)
		if !ok {
			return fmt.Errorf("invalid list")
		}
		if v.Kind() == reflect.Slice {
			v.Set(reflect.MakeSlice(v.Type(), len(xs), len(xs)))
		} else if v.Len() != len(xs) {
			return fmt.Errorf("invalid array length")
		}
		for i, x := range xs {
			if err := c.decode(x, v.Index(i)); err != nil {
				return err
			}
		}
		return nil
	case reflect.Bool:
		x, ok := data.(bool)
		if !ok {
			return fmt.Errorf("invalid boolean")
		}
		v.SetBool(x)
		return nil
	case reflect.String:
		x, ok := data.(string)
		if !ok {
			return fmt.Errorf("invalid string")
		}
		v.SetString(x)
		return nil
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		x, ok := data.(json.Number)
		if !ok {
			return fmt.Errorf("invalid number")
		}
		n, err := x.Int64()
		if err != nil || v.OverflowInt(n) {
			return fmt.Errorf("invalid integer")
		}
		v.SetInt(n)
		return nil
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		x, ok := data.(json.Number)
		if !ok {
			return fmt.Errorf("invalid number")
		}
		n, err := x.Int64()
		if err != nil || n < 0 || v.OverflowUint(uint64(n)) {
			return fmt.Errorf("invalid integer")
		}
		v.SetUint(uint64(n))
		return nil
	default:
		return fmt.Errorf("unsupported destination %s", v.Type())
	}
}
