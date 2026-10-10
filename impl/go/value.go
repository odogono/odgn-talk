package northtalk

import (
	"slices"
	"sync/atomic"
	"time"

	"github.com/odogono/odgn-talk/impl/go/internal/decimal"
	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
)

// Value is an immutable Script value. Its zero value is Nothing.
type Value struct{ inner corevalue.Value }

var Nothing Value

type Kind int

const (
	KindNothing Kind = iota
	KindBool
	KindNumber
	KindQuantity
	KindText
	KindBytes
	KindList
	KindMap
	KindRange
	KindInstant
	KindCivilDate
	KindPattern
	KindFunction
	KindObject
)

type Pair struct {
	Key string
	Val Value
}

func KV(k string, v Value) Pair { return Pair{k, v} }

type DateFields struct {
	Year, Month, Day     int
	HasTime              bool
	Hour, Minute, Second int
	Nanosecond           int
}
type Decimal struct{ inner decimal.Number }

type HostErrorCode string

const InvalidValue HostErrorCode = "invalid value"

type HostError struct {
	Code   HostErrorCode
	Detail string
}

func (e *HostError) Error() string { return string(e.Code) + ": " + e.Detail }
func hostValue(v corevalue.Value, e error) (Value, error) {
	if e != nil {
		return Nothing, &HostError{InvalidValue, e.Error()}
	}
	return Value{v}, nil
}
func Bool(b bool) Value { return Value{corevalue.Value{Kind: corevalue.Boolean, Bool: b}} }
func Text(s string) (Value, error) {
	s, e := normalizeHostText(s)
	return hostValue(corevalue.Fields{Kind: corevalue.Text, Text: s}.Value(), e)
}
func Int(i int64) Value {
	return Value{corevalue.Fields{Kind: corevalue.Number, Number: decimal.FromInt(i)}.Value()}
}
func Uint(u uint64) Value {
	return Value{corevalue.Fields{Kind: corevalue.Number, Number: decimal.FromUint(u)}.Value()}
}
func FromFloat(f float64) (Value, error) {
	n, e := decimal.FromFloat(f)
	return hostValue(corevalue.Fields{Kind: corevalue.Number, Number: n}.Value(), e)
}
func Dec(s string) (Value, error) {
	n, e := decimal.Parse(s)
	return hostValue(corevalue.Fields{Kind: corevalue.Number, Number: n}.Value(), e)
}
func Quantity(n Decimal, unit string) (Value, error) {
	return hostValue(corevalue.NewQuantity(n.inner, unit))
}
func CivilDate(f DateFields) (Value, error) {
	return hostValue(corevalue.NewCivil(corevalue.DateFields(f)))
}
func ParseCivilDate(s string) (Value, error) { return hostValue(corevalue.ParseCivil(s)) }
func Instant(seconds int64, nanos int32) (Value, error) {
	return hostValue(corevalue.NewInstant(seconds, nanos))
}

// InstantFromTime has no error result in talk.go. Like other Go conversions
// that cannot report failure, an out-of-model time is refused with a panic.
func InstantFromTime(t time.Time) Value {
	v, e := Instant(t.Unix(), int32(t.Nanosecond()))
	if e != nil {
		panic(e)
	}
	return v
}
func Bytes(b []byte) Value { return Value{corevalue.NewBytes(b)} }
func List(vs ...Value) Value {
	items := make([]corevalue.Value, len(vs))
	for i, v := range vs {
		items[i] = v.inner
	}
	return Value{corevalue.NewList(items)}
}
func Range(from, to Value) (Value, error) { return hostValue(corevalue.NewRange(from.inner, to.inner)) }
func Map(pairs ...Pair) (Value, error) {
	ps := make([]corevalue.Pair, len(pairs))
	for i, p := range pairs {
		ps[i] = corevalue.Pair{Key: p.Key, Val: p.Val.inner}
	}
	return hostValue(corevalue.NewMap(ps))
}
func (v Value) Kind() Kind { return Kind(v.inner.Kind) }
func (v Value) AsBool() (bool, bool) {
	if v.Kind() != KindBool {
		return false, false
	}
	return v.inner.Bool, true
}
func (v Value) AsText() (string, bool) {
	if v.Kind() != KindText {
		return "", false
	}
	return v.inner.Text(), true
}
func (v Value) AsDec() (Decimal, bool) {
	if v.Kind() != KindNumber {
		return Decimal{}, false
	}
	return Decimal{v.inner.Number()}, true
}
func (v Value) AsQuantity() (Decimal, string, bool) {
	if v.Kind() != KindQuantity {
		return Decimal{}, "", false
	}
	return Decimal{v.inner.Number()}, v.inner.Unit().String(), true
}
func (v Value) AsCivilDate() (DateFields, bool) {
	if v.Kind() != KindCivilDate {
		return DateFields{}, false
	}
	return DateFields(v.inner.Date()), true
}
func (v Value) AsInstant() (seconds int64, nanos int32, ok bool) {
	if v.Kind() != KindInstant {
		return 0, 0, false
	}
	return v.inner.Seconds(), v.inner.Nanos(), true
}
func (v Value) AsBytes() ([]byte, bool) {
	if v.Kind() != KindBytes {
		return nil, false
	}
	return slices.Clone(v.inner.Bytes()), true
}
func (v Value) AsRange() (from, to Value, ok bool) {
	if v.Kind() != KindRange {
		return Nothing, Nothing, false
	}
	return Value{v.inner.Items()[0]}, Value{v.inner.Items()[1]}, true
}
func (v Value) Len() int {
	if v.Kind() != KindList {
		return 0
	}
	return v.inner.ListLen()
}
func (v Value) Index(i int) Value {
	if v.Kind() != KindList || i < 1 || i > v.inner.ListLen() {
		return Nothing
	}
	return Value{v.inner.ListAt(i - 1)}
}
func (v Value) Get(key string) Value {
	if v.Kind() != KindMap {
		return Nothing
	}
	return Value{v.inner.Get(key)}
}
func (v Value) Entries() []Pair {
	if v.Kind() != KindMap {
		return nil
	}
	out := make([]Pair, len(v.inner.Entries()))
	for i, p := range v.inner.Entries() {
		out[i] = Pair{p.Key, Value{p.Val}}
	}
	return out
}
func (v Value) PatternSource() (string, bool) {
	if v.Kind() != KindPattern {
		return "", false
	}
	return v.inner.Text(), true
}
func (v Value) HomeScript() (string, bool) {
	if v.Kind() != KindFunction {
		return "", false
	}
	return v.inner.Function().Home, true
}
func (v Value) String() string { return v.inner.Display() }

// Equal compares values using the Spec's Value Semantics. Quantity comparison
// preserves sequential rounding in Base Unit conversion. Some enormous Unit
// powers require work proportional to the exponent and are impractical to compare.
func (v Value) Equal(w Value) bool { return v.inner.Equal(w.inner) }
func (d Decimal) String() string   { return d.inner.String() }
func (d Decimal) Int64() (int64, error) {
	i, e := d.inner.Int64()
	if e != nil {
		return 0, &HostError{InvalidValue, e.Error()}
	}
	return i, nil
}
func (d Decimal) Uint64() (uint64, error) {
	u, e := d.inner.Uint64()
	if e != nil {
		return 0, &HostError{InvalidValue, e.Error()}
	}
	return u, nil
}
func (d Decimal) Float64Lossy() float64 { return d.inner.Float64() }

type ObjectKind struct {
	name        string
	props       map[string]Prop
	parentKinds []string
}
type Object struct {
	kind     *ObjectKind
	id       string
	native   any
	group    *Group
	disposed atomic.Bool
	parent   *Object // protected by group.mu
	owner    *Script // protected by group.mu
}

func (o *Object) ID() string        { return o.id }
func (o *Object) Kind() *ObjectKind { return o.kind }
func (o *Object) Native() any       { return o.native }
func (o *Object) Value() Value {
	return Value{corevalue.Fields{Kind: corevalue.Object, Object: &corevalue.ObjectData{Kind: o.kind.name, ID: o.id, Handle: o, Disposed: &o.disposed}}.Value()}
}
func (v Value) AsObject() (*Object, bool) {
	if v.Kind() != KindObject {
		return nil, false
	}
	o, ok := v.inner.Object().Handle.(*Object)
	return o, ok
}
