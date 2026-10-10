// Package snapshot encodes plain machine data and explicitly named external
// references. It never serializes native handles, Host code or synchronization.
package snapshot

import (
	"bytes"
	"encoding/json"
	"encoding/json/jsontext"
	"fmt"
	"math/big"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/odogono/odgn-talk/impl/go/internal/decimal"
	"github.com/odogono/odgn-talk/impl/go/internal/generated"
	"github.com/odogono/odgn-talk/impl/go/internal/value"
)

type Codec struct {
	ValueType   reflect.Type
	UnwrapValue func(any) value.Value
	WrapValue   func(value.Value) any

	Reference func(reflect.Value) (string, bool)
	Resolve   func(string) (any, bool)
	Object    func(kind, id string) (value.Value, error)
	Function  func(*value.FunctionData) error
}

var valueType = reflect.TypeFor[value.Value]()
var fieldsType = reflect.TypeFor[value.Fields]()
var unitType = reflect.TypeFor[value.Unit]()
var numberType = reflect.TypeFor[decimal.Number]()
var objectType = reflect.TypeFor[*value.ObjectData]()
var timeType = reflect.TypeFor[time.Time]()
var bigType = reflect.TypeFor[big.Int]()

// Marshal writes the wire layout directly, without a second tree of boxed
// maps and slices. Struct metadata is cached; field names remain sorted exactly
// as encoding/json sorted the old map representation (JSON tags are ignored).
func (c Codec) Marshal(v any) ([]byte, error) {
	return c.append(nil, reflect.ValueOf(v))
}

func (c Codec) Unmarshal(data []byte, out any) error {
	target := reflect.ValueOf(out)
	if target.Kind() != reflect.Pointer || target.IsNil() {
		return fmt.Errorf("snapshot needs a destination")
	}
	// Canonical saves decode without building a JSON object tree. Legacy input
	// can contain duplicate members or a $ref after other members: the old map
	// decoder used the last member, before applying any semantic checks. If the
	// streaming path fails, normalize that uncommon input with the old JSON
	// rules and retry, retaining exact integer spelling with UseNumber.
	err := c.read(newDecoder(data), target.Elem())
	if err == nil {
		return nil
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	var raw any
	if e := d.Decode(&raw); e != nil {
		return err
	}
	normalized, e := json.Marshal(raw)
	if e != nil || bytes.Equal(normalized, data) {
		return err
	}
	return c.read(newDecoder(normalized), target.Elem())
}

func newDecoder(data []byte) *jsontext.Decoder {
	return jsontext.NewDecoder(bytes.NewBuffer(data), jsontext.AllowDuplicateNames(true), jsontext.AllowInvalidUTF8(true))
}

type wireField struct {
	name   string
	index  int
	quoted []byte
}
type structLayout struct {
	fields []wireField
	byName map[string]int
}

var layouts sync.Map // reflect.Type -> *structLayout; immutable after publication
func layout(t reflect.Type) *structLayout {
	if x, ok := layouts.Load(t); ok {
		return x.(*structLayout)
	}
	x := &structLayout{byName: make(map[string]int)}
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		if f.IsExported() {
			quoted, _ := json.Marshal(f.Name)
			x.fields = append(x.fields, wireField{f.Name, i, append(quoted, ':')})
		}
	}
	slices.SortFunc(x.fields, func(a, b wireField) int { return strings.Compare(a.name, b.name) })
	for i, f := range x.fields {
		x.byName[f.name] = i
	}
	actual, _ := layouts.LoadOrStore(t, x)
	return actual.(*structLayout)
}
func quote(dst []byte, s string) []byte {
	// Most snapshot strings need only JSON quoting. Use the compatibility
	// encoder for HTML/JavaScript escapes, including U+2028 and U+2029.
	if strings.ContainsAny(s, "<>&\u2028\u2029") {
		b, _ := json.Marshal(s)
		return append(dst, b...)
	}
	dst, _ = jsontext.AppendQuote(dst, s)
	return dst
}
func (c Codec) append(dst []byte, v reflect.Value) ([]byte, error) {
	if !v.IsValid() {
		return append(dst, "null"...), nil
	}
	if v.Kind() == reflect.Interface {
		if v.IsNil() {
			return append(dst, "null"...), nil
		}
		return c.append(dst, v.Elem())
	}
	if (v.Kind() == reflect.Pointer || v.Kind() == reflect.Slice || v.Kind() == reflect.Map) && v.IsNil() {
		return append(dst, "null"...), nil
	}
	if v.Type() == c.ValueType {
		return c.append(dst, reflect.ValueOf(c.UnwrapValue(v.Interface())))
	}
	if v.Type() == valueType {
		return c.append(dst, reflect.ValueOf(v.Interface().(value.Value).Fields()))
	}
	if c.Reference != nil {
		if ref, ok := c.Reference(v); ok {
			dst = append(dst, `{"$ref":`...)
			return append(quote(dst, ref), '}'), nil
		}
	}
	if v.Type() == objectType {
		o := v.Interface().(*value.ObjectData)
		dst = append(dst, `{"id":`...)
		dst = quote(dst, o.ID)
		dst = append(dst, `,"kind":`...)
		return append(quote(dst, o.Kind), '}'), nil
	}
	if v.Type() == numberType {
		return quote(dst, v.Interface().(decimal.Number).Snapshot()), nil
	}
	if v.Type() == timeType {
		return quote(dst, v.Interface().(time.Time).Format(time.RFC3339Nano)), nil
	}
	if v.Type() == bigType {
		n := v.Interface().(big.Int)
		return quote(dst, n.String()), nil
	}
	var err error
	switch v.Kind() {
	case reflect.Pointer:
		return c.append(dst, v.Elem())
	case reflect.Struct:
		dst = append(dst, '{')
		for i, f := range layout(v.Type()).fields {
			if i > 0 {
				dst = append(dst, ',')
			}
			dst = append(dst, f.quoted...)
			dst, err = c.append(dst, v.Field(f.index))
			if err != nil {
				return nil, err
			}
		}
		return append(dst, '}'), nil
	case reflect.Map:
		keys := v.MapKeys()
		slices.SortFunc(keys, func(a, b reflect.Value) int { return strings.Compare(mapKey(a), mapKey(b)) })
		dst = append(dst, '{')
		for i, k := range keys {
			if i > 0 {
				dst = append(dst, ',')
			}
			dst = append(quote(dst, mapKey(k)), ':')
			dst, err = c.append(dst, v.MapIndex(k))
			if err != nil {
				return nil, err
			}
		}
		return append(dst, '}'), nil
	case reflect.Array, reflect.Slice:
		dst = append(dst, '[')
		for i := 0; i < v.Len(); i++ {
			if i > 0 {
				dst = append(dst, ',')
			}
			dst, err = c.append(dst, v.Index(i))
			if err != nil {
				return nil, err
			}
		}
		return append(dst, ']'), nil
	case reflect.Bool:
		return strconv.AppendBool(dst, v.Bool()), nil
	case reflect.String:
		return quote(dst, v.String()), nil
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return strconv.AppendInt(dst, v.Int(), 10), nil
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return strconv.AppendUint(dst, v.Uint(), 10), nil
	default:
		return nil, fmt.Errorf("executable or unsupported snapshot field %s", v.Type())
	}
}
func mapKey(v reflect.Value) string {
	if v.Kind() == reflect.String && v.Type().NumMethod() == 0 {
		return v.String()
	}
	return fmt.Sprint(v.Interface())
}

// read consumes one value directly into its typed destination. Only restored
// slices/maps and actual value metadata are allocated, never a JSON object tree.
func (c Codec) read(d *jsontext.Decoder, v reflect.Value) error {
	t, err := d.ReadToken()
	if err != nil {
		return err
	}
	name := ""
	end := false
	if t.Kind() == '{' {
		key, err := d.ReadToken()
		if err != nil {
			return err
		}
		end = key.Kind() == '}'
		if !end {
			name = key.String()
		}
	}
	return c.readToken(d, t, v, name, end)
}
func (c Codec) resolve(key string, v reflect.Value) error {
	if c.Resolve == nil {
		return fmt.Errorf("unknown reference %s", key)
	}
	x, ok := c.Resolve(key)
	if !ok {
		return fmt.Errorf("unknown reference %s", key)
	}
	r := reflect.ValueOf(x)
	if !r.IsValid() || !r.Type().AssignableTo(v.Type()) {
		return fmt.Errorf("invalid reference %s", key)
	}
	v.Set(r)
	return nil
}
func (c Codec) readToken(d *jsontext.Decoder, t jsontext.Token, v reflect.Value, name string, end bool) error {
	if t.Kind() == 'n' {
		switch v.Kind() {
		case reflect.Pointer, reflect.Map, reflect.Slice, reflect.Interface:
			v.SetZero()
			return nil
		default:
			return fmt.Errorf("null %s", v.Type())
		}
	}
	if t.Kind() == '{' && name == "$ref" && d.PeekKind() == '"' {
		key, err := d.ReadToken()
		if err != nil {
			return err
		}
		if key.Kind() != '"' {
			return fmt.Errorf("invalid reference")
		}
		ref := key.String()
		for d.PeekKind() != '}' {
			name, err := d.ReadToken()
			if err != nil {
				return err
			}
			if name.String() == "$ref" {
				key, err := d.ReadToken()
				if err != nil {
					return err
				}
				if key.Kind() != '"' {
					return fmt.Errorf("invalid reference")
				}
				ref = key.String()
			} else if err := d.SkipValue(); err != nil {
				return err
			}
		}
		if _, err := d.ReadToken(); err != nil {
			return err
		}
		return c.resolve(ref, v)
	}
	if v.Type() == c.ValueType {
		var x value.Value
		if err := c.readToken(d, t, reflect.ValueOf(&x).Elem(), name, end); err != nil {
			return err
		}
		v.Set(reflect.ValueOf(c.WrapValue(x)))
		return nil
	}
	if v.Type() == valueType {
		var fields value.Fields
		if err := c.readToken(d, t, reflect.ValueOf(&fields).Elem(), name, end); err != nil {
			return err
		}
		x := fields.Value()
		// Older dimensionless Numbers can contain an empty, non-nil Unit slice.
		if fields.Kind != value.Quantity && len(fields.Unit.Slots) == 0 {
			fields.Unit = value.Unit{}
		}
		if !activeFields(fields) {
			return fmt.Errorf("inactive Value fields")
		}
		v.Set(reflect.ValueOf(x))
		return nil
	}
	if v.Type() == objectType {
		if t.Kind() != '{' || c.Object == nil {
			return fmt.Errorf("invalid Object")
		}
		var kind, id string
		var hasKind, hasID bool
		for !end {
			if name == "kind" || name == "id" {
				x, err := d.ReadToken()
				if err != nil {
					return err
				}
				if x.Kind() != '"' {
					return fmt.Errorf("invalid Object")
				}
				if name == "kind" {
					kind, hasKind = x.String(), true
				} else {
					id, hasID = x.String(), true
				}
			} else if err := d.SkipValue(); err != nil {
				return err
			}
			key, err := d.ReadToken()
			if err != nil {
				return err
			}
			end = key.Kind() == '}'
			if !end {
				name = key.String()
			}
		}
		if !hasKind || !hasID {
			return fmt.Errorf("invalid Object")
		}
		x, err := c.Object(kind, id)
		if err != nil {
			return err
		}
		v.Set(reflect.ValueOf(x.Object()))
		return nil
	}
	if v.Type() == numberType {
		if t.Kind() != '"' {
			return fmt.Errorf("invalid decimal")
		}
		x, err := decimal.RestoreSnapshot(t.String())
		if err != nil {
			return err
		}
		v.Set(reflect.ValueOf(x))
		return nil
	}
	if v.Type() == timeType {
		if t.Kind() != '"' {
			return fmt.Errorf("invalid Clock")
		}
		x, err := time.Parse(time.RFC3339Nano, t.String())
		if err != nil {
			return err
		}
		v.Set(reflect.ValueOf(x))
		return nil
	}
	if v.Type() == bigType {
		if t.Kind() != '"' {
			return fmt.Errorf("invalid integer")
		}
		n, ok := new(big.Int).SetString(t.String(), 10)
		if !ok {
			return fmt.Errorf("invalid integer")
		}
		v.Set(reflect.ValueOf(*n))
		return nil
	}
	switch v.Kind() {
	case reflect.Pointer:
		v.Set(reflect.New(v.Type().Elem()))
		return c.readToken(d, t, v.Elem(), name, end)
	case reflect.Struct:
		if t.Kind() != '{' {
			return fmt.Errorf("invalid %s", v.Type())
		}
		fields := layout(v.Type())
		seen := make([]bool, len(fields.fields))
		for !end {
			if i, ok := fields.byName[name]; ok {
				f := fields.fields[i]
				if err := c.read(d, v.Field(f.index)); err != nil {
					return fmt.Errorf("%s: %w", f.name, err)
				}
				seen[i] = true
			} else if err := d.SkipValue(); err != nil {
				return err
			}
			key, err := d.ReadToken()
			if err != nil {
				return err
			}
			end = key.Kind() == '}'
			if !end {
				name = key.String()
			}
		}
		for i, f := range fields.fields {
			if !seen[i] {
				return fmt.Errorf("missing %s.%s", v.Type(), f.name)
			}
		}
		return c.validate(v)
	case reflect.Map:
		if t.Kind() != '{' {
			return fmt.Errorf("invalid map")
		}
		v.Set(reflect.MakeMap(v.Type()))
		for !end {
			k := reflect.New(v.Type().Key()).Elem()
			if k.Kind() == reflect.String {
				k.SetString(name)
			} else {
				n, err := strconv.ParseInt(name, 10, 64)
				if err != nil {
					return fmt.Errorf("invalid integer")
				}
				switch k.Kind() {
				case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
					if k.OverflowInt(n) {
						return fmt.Errorf("invalid integer")
					}
					k.SetInt(n)
				case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
					if n < 0 || k.OverflowUint(uint64(n)) {
						return fmt.Errorf("invalid integer")
					}
					k.SetUint(uint64(n))
				default:
					return fmt.Errorf("unsupported destination %s", k.Type())
				}
			}
			val := reflect.New(v.Type().Elem()).Elem()
			if err := c.read(d, val); err != nil {
				return err
			}
			v.SetMapIndex(k, val)
			key, err := d.ReadToken()
			if err != nil {
				return err
			}
			end = key.Kind() == '}'
			if !end {
				name = key.String()
			}
		}
		return nil
	case reflect.Array, reflect.Slice:
		if t.Kind() != '[' {
			return fmt.Errorf("invalid list")
		}
		if v.Kind() == reflect.Slice {
			v.Set(reflect.MakeSlice(v.Type(), 0, 0))
		}
		i := 0
		for d.PeekKind() != ']' {
			if v.Kind() == reflect.Slice {
				v.Grow(1)
				v.SetLen(i + 1)
			} else if i >= v.Len() {
				return fmt.Errorf("invalid array length")
			}
			if err := c.read(d, v.Index(i)); err != nil {
				return err
			}
			i++
		}
		if _, err := d.ReadToken(); err != nil {
			return err
		}
		if v.Kind() == reflect.Array && i != v.Len() {
			return fmt.Errorf("invalid array length")
		}
		return nil
	case reflect.Bool:
		if t.Kind() != 't' && t.Kind() != 'f' {
			return fmt.Errorf("invalid boolean")
		}
		v.SetBool(t.Bool())
		return nil
	case reflect.String:
		if t.Kind() != '"' {
			return fmt.Errorf("invalid string")
		}
		v.SetString(t.String())
		return nil
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		if t.Kind() != '0' {
			return fmt.Errorf("invalid number")
		}
		n, err := strconv.ParseInt(t.String(), 10, 64)
		if err != nil || v.OverflowInt(n) {
			return fmt.Errorf("invalid integer")
		}
		v.SetInt(n)
		return nil
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		if t.Kind() != '0' {
			return fmt.Errorf("invalid number")
		}
		n, err := strconv.ParseInt(t.String(), 10, 64)
		if err != nil || n < 0 || v.OverflowUint(uint64(n)) {
			return fmt.Errorf("invalid integer")
		}
		v.SetUint(uint64(n))
		return nil
	default:
		return fmt.Errorf("unsupported destination %s", v.Type())
	}
}
func (c Codec) validate(v reflect.Value) error {
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
	if v.Type() == fieldsType {
		x := v.Interface().(value.Fields).Value()
		if x.Kind < value.Nothing || x.Kind > value.Deadline {
			return fmt.Errorf("invalid Value kind")
		}
		if x.Kind == value.Function && x.Function() == nil || x.Kind == value.Object && x.Object() == nil {
			return fmt.Errorf("missing Value metadata")
		}
		if x.Kind == value.Function && c.Function != nil {
			if err := c.Function(x.Function()); err != nil {
				return err
			}
		}
		if x.Kind == value.Range {
			if len(x.Items()) != 2 {
				return fmt.Errorf("invalid Range")
			}
			if _, err := value.NewRange(x.Items()[0], x.Items()[1]); err != nil {
				return err
			}
		}
		if x.Kind == value.Quantity && len(x.Unit().Slots) == 0 {
			return fmt.Errorf("dimensionless Quantity")
		}
		if x.Kind == value.Iterator && x.Iterator() == nil || x.Kind == value.BinaryReader && x.Reader() == nil || x.Kind == value.Replacement && x.Replacement() == nil || x.Kind == value.Deadline && (x.Deadline() == nil || x.Deadline().At == nil) {
			return fmt.Errorf("missing internal Value state")
		}
	}
	return nil
}

// Packing a Value drops inactive fields. Reject those fields before packing,
// without boxing two 312-byte Fields structs for reflect.DeepEqual per Value.
// Bool and CoreMessage are retained by Fields.Value for every tagged kind.
func activeFields(f value.Fields) bool {
	switch f.Kind {
	case value.Number:
		f.Number = decimal.Number{}
	case value.Quantity:
		f.Number = decimal.Number{}
		f.Unit = value.Unit{}
	case value.Text, value.Pattern:
		f.Text = ""
	case value.Bytes:
		f.Bytes = nil
	case value.List, value.Range:
		f.Items = nil
	case value.Map:
		f.Entries = nil
	case value.CivilDate:
		f.Date = value.DateFields{}
	case value.Instant:
		f.Seconds = 0
		f.Nanos = 0
	case value.Object:
		f.Object = nil
	case value.Function:
		f.Function = nil
	case value.Iterator:
		f.Iterator = nil
	case value.BinaryReader:
		f.Reader = nil
	case value.Replacement:
		f.Replacement = nil
	case value.Deadline:
		f.Deadline = nil
	}
	return f.Reader == nil && f.Replacement == nil && f.Iterator == nil && f.Deadline == nil &&
		f.Number == (decimal.Number{}) && f.Text == "" && f.Bytes == nil && f.Items == nil && f.Entries == nil &&
		f.Unit.Slots == nil && f.Date == (value.DateFields{}) && f.Seconds == 0 && f.Nanos == 0 && f.Object == nil && f.Function == nil
}
