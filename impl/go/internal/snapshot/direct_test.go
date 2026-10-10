package snapshot

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math/big"
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/odogono/odgn-talk/impl/go/internal/decimal"
	"github.com/odogono/odgn-talk/impl/go/internal/value"
)

type snapshotKey string

func (k snapshotKey) String() string { return "key/" + string(k) }

func TestDirectCodecMatchesLegacyBytes(t *testing.T) {
	type row struct {
		Z       string `json:"renamed,omitempty"`
		A       []byte
		Empty   []int
		Nil     []int
		Map     map[int]string
		Pointer *int
		Clock   time.Time
		Big     big.Int
		Number  decimal.Number
		hidden  int
	}
	n := 42
	number, err := decimal.Parse("-12.50")
	if err != nil {
		t.Fatal(err)
	}
	cases := []any{
		nil, true, map[snapshotKey]int{"x": 1}, int64(-1 << 63), uint64(1<<64 - 1), [3]byte{0, 128, 255},
		row{Z: "<>&\u2028\u2029\x00\n\t\"\\\xff", A: []byte{0, 255}, Empty: []int{}, Map: map[int]string{2: "two", 10: "ten", -1: "minus"}, Pointer: &n, Clock: time.Unix(42, 123).UTC(), Big: *big.NewInt(-123), Number: number},
		map[string]any{"z": []string{}, "a": (*int)(nil), "b": map[string]int{}},
	}
	codec := Codec{}
	old := legacyCodec(codec)
	for _, input := range cases {
		t.Run(fmt.Sprintf("%T", input), func(t *testing.T) {
			want, err := old.Marshal(input)
			if err != nil {
				t.Fatal(err)
			}
			got, err := codec.Marshal(input)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(got, want) {
				t.Fatalf("wire bytes differ:\n%s\n%s", got, want)
			}
			// Interfaces in this fixture intentionally cannot be restored as plain data.
			if input == nil || reflect.TypeOf(input).Kind() == reflect.Map {
				return
			}
			a, b := reflect.New(reflect.TypeOf(input)), reflect.New(reflect.TypeOf(input))
			oldErr, newErr := old.Unmarshal(want, a.Interface()), codec.Unmarshal(got, b.Interface())
			if (oldErr == nil) != (newErr == nil) {
				t.Fatalf("restore differs: old=%v new=%v", oldErr, newErr)
			}
			if oldErr == nil && !reflect.DeepEqual(a.Interface(), b.Interface()) {
				t.Fatalf("restored data differs: %v / %v", a, b)
			}
		})
	}
}

func TestDirectCodecReferences(t *testing.T) {
	type object struct{ Name string }
	type row struct {
		Ref   *object
		Other any
	}
	obj := &object{"home"}
	c := Codec{Reference: func(v reflect.Value) (string, bool) {
		return "home", v.Type() == reflect.TypeOf(obj) && v.Interface() == obj
	}, Resolve: func(key string) (any, bool) { return obj, key == "home" }}
	input := row{obj, obj}
	want, err := legacyCodec(c).Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	got, err := c.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("references differ: %s / %s", got, want)
	}
	var restored row
	if err := c.Unmarshal(got, &restored); err != nil {
		t.Fatal(err)
	}
	if restored.Ref != obj || restored.Other != obj {
		t.Fatal("reference identity lost")
	}
	for _, input := range []string{`{"$ref":"missing"}`, `{"$ref":"home"}`} {
		var wrong int
		if err := c.Unmarshal([]byte(input), &wrong); err == nil {
			t.Fatal("accepted invalid reference")
		}
	}
}

func TestDirectCodecValueValidationMatchesLegacy(t *testing.T) {
	data, err := os.ReadFile("testdata/values-go6.json")
	if err != nil {
		t.Fatal(err)
	}
	var rows []map[string]any
	if err := json.Unmarshal(data, &rows); err != nil {
		t.Fatal(err)
	}
	mutations := map[string]any{
		"Kind": 999, "Bool": true, "Text": "inactive", "Bytes": []any{}, "Items": []any{}, "Entries": []any{},
		"Seconds": 1, "Nanos": 1, "Number": `["1",0,""]`, "Unit": map[string]any{"Slots": []any{}},
		"Date": map[string]any{"Year": 1, "Month": 0, "Day": 0, "Hour": 0, "Minute": 0, "Second": 0, "Nanosecond": 0, "HasTime": false},
	}
	for i, row := range rows {
		for field, x := range mutations {
			t.Run(fmt.Sprintf("%d/%s", i, field), func(t *testing.T) {
				changed := make(map[string]any, len(row))
				for k, v := range row {
					changed[k] = v
				}
				changed[field] = x
				raw, err := json.Marshal(changed)
				if err != nil {
					t.Fatal(err)
				}
				compareValueDecode(t, raw)
			})
		}
	}
}

func compareValueDecode(t *testing.T, raw []byte) {
	t.Helper()
	var a, b value.Value
	oldErr := (legacyCodec{}).Unmarshal(raw, &a)
	newErr := (Codec{}).Unmarshal(raw, &b)
	if (oldErr == nil) != (newErr == nil) {
		t.Fatalf("acceptance differs for %s: old=%v new=%v", raw, oldErr, newErr)
	}
	if oldErr == nil {
		want, err := (legacyCodec{}).Marshal(a)
		if err != nil {
			t.Fatal(err)
		}
		got, err := (Codec{}).Marshal(b)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(want, got) {
			t.Fatalf("decoded wire data differs: %s / %s", want, got)
		}
	}
}

func FuzzSnapshotValueCompatibility(f *testing.F) {
	data, err := os.ReadFile("testdata/values-go6.json")
	if err != nil {
		f.Fatal(err)
	}
	var rows []json.RawMessage
	if err := json.Unmarshal(data, &rows); err != nil {
		f.Fatal(err)
	}
	for _, row := range rows {
		f.Add([]byte(row))
	}
	f.Fuzz(func(t *testing.T, raw []byte) { compareValueDecode(t, raw) })
}

func FuzzSnapshotStringBytes(f *testing.F) {
	f.Add("<>&\u2028\u2029\x00\n\t\"\\\xff")
	f.Fuzz(func(t *testing.T, s string) {
		want, err := (legacyCodec{}).Marshal(s)
		if err != nil {
			t.Fatal(err)
		}
		got, err := (Codec{}).Marshal(s)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(got, want) {
			t.Fatalf("string encoding differs for %q: %s / %s", s, got, want)
		}
	})
}

func TestDirectCodecJSONRules(t *testing.T) {
	type row struct {
		A int8
		B []byte
	}
	type object struct{ Name string }
	obj := &object{"home"}
	c := Codec{Resolve: func(key string) (any, bool) { return obj, key == "home" }}
	cases := []struct {
		raw    string
		target any
	}{
		{`null`, int(0)}, {`null`, []byte{}}, {`[]`, []byte{}}, {`[255,0]`, []byte{}},
		{`[256]`, []byte{}}, {`[-1]`, []byte{}}, {`[1.0]`, []byte{}},
		{`[1]`, [2]int{}}, {`[1,2,3]`, [2]int{}}, {`[1,2]`, [2]int{}},
		{`{"2":"two","10":"ten"}`, map[int]string{}}, {`{"-1":0}`, map[uint]int{}},
		{`{"A":127,"B":null}`, row{}}, {`{"B":[],"A":-128,"ignored":{}}`, row{}},
		{`{"B":null}`, row{}}, {`{"A":128,"B":null}`, row{}},
		{`{"A":false,"A":1,"B":null}`, row{}}, {`{"A":1,"A":false,"B":null}`, row{}},
		{`{"A":1,"B":[1],"B":null}`, row{}},
		{`{"$ref":"home","extra":1}`, (*object)(nil)},
		{`{"extra":1,"$ref":"home"}`, (*object)(nil)},
		{`{"$ref":"missing","$ref":"home"}`, (*object)(nil)},
		{`{"$ref":"home","$ref":"missing"}`, (*object)(nil)},
		{`{"$ref":0,"Name":"plain"}`, (*object)(nil)},
		{`{"$ref":"home","$ref":0,"Name":"plain"}`, (*object)(nil)},
	}
	for i, tc := range cases {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			a, b := reflect.New(reflect.TypeOf(tc.target)), reflect.New(reflect.TypeOf(tc.target))
			oldErr, newErr := legacyCodec(c).Unmarshal([]byte(tc.raw), a.Interface()), c.Unmarshal([]byte(tc.raw), b.Interface())
			if (oldErr == nil) != (newErr == nil) {
				t.Fatalf("acceptance differs for %s: old=%v new=%v", tc.raw, oldErr, newErr)
			}
			if oldErr == nil && !reflect.DeepEqual(a.Interface(), b.Interface()) {
				t.Fatalf("data differs for %s", tc.raw)
			}
		})
	}
}
