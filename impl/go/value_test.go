package northtalk

import (
	"errors"
	"math"
	"testing"
	"time"
)

func dec(t *testing.T, s string) Value {
	t.Helper()
	v, e := Dec(s)
	if e != nil {
		t.Fatal(e)
	}
	return v
}
func text(t *testing.T, s string) Value {
	t.Helper()
	v, e := Text(s)
	if e != nil {
		t.Fatal(e)
	}
	return v
}
func quantity(t *testing.T, s, u string) Value {
	t.Helper()
	d, _ := dec(t, s).AsDec()
	v, e := Quantity(d, u)
	if e != nil {
		t.Fatal(e)
	}
	return v
}
func TestHostValueConstructors(t *testing.T) {
	if Nothing.Kind() != KindNothing || (Value{}).Kind() != KindNothing {
		t.Fatal("zero Value is Nothing")
	}
	if b, ok := Bool(true).AsBool(); !ok || !b {
		t.Fatal("boolean")
	}
	if s, ok := text(t, "e\u0301").AsText(); !ok || s != "é" {
		t.Fatal(s)
	}
	for _, v := range []Value{Int(math.MinInt64), Uint(math.MaxUint64), dec(t, "2.50")} {
		if v.Kind() != KindNumber {
			t.Fatal(v)
		}
	}
	for _, fn := range []func() (Value, error){func() (Value, error) { return Text("\xff") }, func() (Value, error) { return FromFloat(math.NaN()) }, func() (Value, error) { return Dec("1e3") }, func() (Value, error) { return Map(KV("é", Int(1)), KV("e\u0301", Int(2))) }, func() (Value, error) { return Quantity(Decimal{}, "nope") }, func() (Value, error) { return Range(Int(1), Bool(true)) }} {
		_, e := fn()
		var h *HostError
		if !errors.As(e, &h) || h.Code != InvalidValue {
			t.Fatalf("want invalid value, got %v", e)
		}
	}
}
func TestImmutableContainersAndMapOrder(t *testing.T) {
	b := []byte{1, 2}
	v := Bytes(b)
	b[0] = 99
	out, _ := v.AsBytes()
	out[1] = 99
	if v.String() != "<<0x01, 0x02>>" {
		t.Fatal(v)
	}
	vs := []Value{Int(1), Nothing}
	l := List(vs...)
	vs[0] = Int(9)
	if l.Index(1).String() != "1" || l.Len() != 2 || l.Index(0).Kind() != KindNothing || l.Index(3).Kind() != KindNothing {
		t.Fatal(l)
	}
	pairs := []Pair{KV("e\u0301", l), KV("b", Nothing)}
	m, e := Map(pairs...)
	if e != nil {
		t.Fatal(e)
	}
	pairs[0] = KV("x", Nothing)
	es := m.Entries()
	es[0].Key = "x"
	if m.Entries()[0].Key != "é" || !m.Get("e\u0301").Equal(l) || m.Get("missing").Kind() != KindNothing {
		t.Fatal(m)
	}
	reverse, e := Map(KV("b", Nothing), KV("é", l))
	if e != nil || !m.Equal(reverse) || m.String() == reverse.String() {
		t.Fatal("map equality ignores order")
	}
	empty, _ := Map()
	if empty.Equal(m) || empty.Equal(List()) {
		t.Fatal("different maps/kinds")
	}
	if _, ok := l.AsText(); ok {
		t.Fatal("wrong accessor")
	}
}
func TestValueEquality(t *testing.T) {
	for _, tt := range []struct {
		a, b  Value
		equal bool
	}{{dec(t, "1.0"), Int(1), true}, {quantity(t, "5", "kg"), quantity(t, "5000", "g"), true}, {quantity(t, "1", "L"), quantity(t, "1000", "mL"), true}, {quantity(t, "1", "month"), quantity(t, "1", "day"), false}, {quantity(t, "5", "kg"), Int(5), false}, {text(t, "A"), text(t, "a"), false}} {
		if tt.a.Equal(tt.b) != tt.equal {
			t.Errorf("%s = %s", tt.a, tt.b)
		}
	}
	r, e := Range(quantity(t, "3", "m"), quantity(t, "7", "cm"))
	if e != nil || r.String() != "3 m..7 cm" {
		t.Fatal(r, e)
	}
	if _, e := Range(quantity(t, "1", "m"), quantity(t, "1", "s")); e == nil {
		t.Fatal("dimensions")
	}
}
func TestDateValidationAndInstants(t *testing.T) {
	for _, s := range []string{"2026-09-27", "2026-09-27T14:30:00.500000000", "0001-01-01", "9999-12-31"} {
		v, e := ParseCivilDate(s)
		if e != nil {
			t.Fatal(s, e)
		}
		f, ok := v.AsCivilDate()
		again, e := CivilDate(f)
		if !ok || e != nil || !v.Equal(again) {
			t.Fatal(v)
		}
	}
	for _, s := range []string{"0000-01-01", "2026-02-30", "2026-09-27T23:59:60", "2026-09-27T14:30:00Z", "2026-09-27T14:30:00.1234567890"} {
		if _, e := ParseCivilDate(s); e == nil {
			t.Fatal("accepted", s)
		}
	}
	if _, e := CivilDate(DateFields{Year: 2026, Month: 1, Day: 1, Hour: 1}); e == nil {
		t.Fatal("time without HasTime")
	}
	if _, e := Instant(0, -1); e == nil {
		t.Fatal("negative nanos")
	}
	if _, e := Instant(0, 1e9); e == nil {
		t.Fatal("large nanos")
	}
	v, e := Instant(-1, 999999999)
	if e != nil || v.String() != "1969-12-31T23:59:59.999999999Z" {
		t.Fatal(v, e)
	}
	stamp := time.Date(2026, 9, 27, 14, 30, 0, 500000000, time.FixedZone("offset", 3600))
	if InstantFromTime(stamp).String() != "2026-09-27T13:30:00.5Z" {
		t.Fatal("time conversion")
	}
}
func TestDecimalAccessors(t *testing.T) {
	d, _ := dec(t, "2.50").AsDec()
	if d.String() != "2.50" || d.Float64Lossy() != 2.5 {
		t.Fatal(d)
	}
	if _, e := d.Int64(); e == nil {
		t.Fatal("fraction")
	}
	d, _ = dec(t, "3.0").AsDec()
	if i, e := d.Int64(); e != nil || i != 3 {
		t.Fatal(i, e)
	}
}

func TestLargeQuantitiesRemainComparable(t *testing.T) {
	huge := quantity(t, "9999999999999999999999999999999999", "km")
	if !huge.Equal(huge) {
		t.Fatal("large quantity unequal to itself")
	}
	a := quantity(t, "1000000000000000000000000000000", "week")
	b := quantity(t, "7000000000000000000000000000000", "day")
	if !a.Equal(b) {
		t.Fatal("equal base magnitudes past the number limit")
	}
	unit := quantity(t, "1", "m^2147483647")
	if !unit.Equal(unit) {
		t.Fatal("large unit exponent")
	}
}
