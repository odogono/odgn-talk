package corpus

import (
	"math"
	"testing"

	talk "github.com/odogono/odgn-talk/impl/go"
)

func TestSqliteStubValues(t *testing.T) {
	text := func(s string) talk.Value { v, _ := talk.Text(s); return v }
	real := func(s string) talk.Value { v, _ := talk.Map(talk.KV("real", text(s))); return v }
	dec := func(s string) talk.Value { v, _ := talk.Dec(s); return v }
	for _, test := range []struct {
		in   talk.Value
		want any
	}{
		{talk.Nothing, nil}, {dec("7"), int64(7)}, {dec("7.0"), 7.0}, {dec("9223372036854775808"), 9223372036854775808.0},
		{text("x"), "x"}, {real("1e400"), math.Inf(1)}, {real("-Infinity"), math.Inf(-1)}, {real("0.5"), 0.5},
		{talk.Bool(true), notSql{}}, {talk.List(), notSql{}},
	} {
		got, err := sqlOf(test.in)
		if err != nil || got != test.want {
			t.Fatalf("%s: got %#v %v", test.in, got, err)
		}
	}
	if v, _ := sqlOf(real("NaN")); !math.IsNaN(v.(float64)) {
		t.Fatal("NaN")
	}
	for _, bad := range []string{"1.", ".5", "0x10", "inf"} {
		if _, err := sqlOf(real(bad)); err == nil {
			t.Fatalf("%s: accepted", bad)
		}
	}
	if b, ok := sqliteBindingOf(Setup{"database": "d", "maxRows": int64(3), "tables": []any{"t"}}).(talk.SqliteBinding); !ok || b.MaxRows != 3 || b.Tables[0] != "t" {
		t.Fatal("binding")
	}
	if _, ok := sqliteBindingOf(Setup{"database": "d"}).(talk.SqliteBinding); ok {
		t.Fatal("binding without maxRows")
	}
}
