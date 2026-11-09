package northtalk

import "testing"

// Host checks (ADR 0176): a Host-built Shape, the Built-in's acceptance and report.
func TestConformsAndExplain(t *testing.T) {
	text := func(s string) Value { v, _ := Text(s); return v }
	line := MapShape(Field{Key: "sku", Shape: TextShape}, Field{Key: "qty", Shape: NumberShape})
	invoice := MapShape(
		Field{Key: "amount", Shape: QuantityOf("GBP")},
		Field{Key: "lines", Shape: ListOf(line)},
		Field{Key: "ref", Shape: TextShape, Optional: true},
	)
	good, _ := Map(KV("lines", List()), KV("amount", must(Quantity(mustDec(Int(3)), "GBP"))))
	if !Conforms(good, invoice) {
		t.Fatal("a fitting value should conform")
	}
	if got := encoded(t, Explain(good, invoice)); got != "[]" {
		t.Fatalf("explain of a fit = %s", got)
	}
	sku, _ := Map(KV("sku", Int(1)), KV("qty", Int(2)))
	bad, _ := Map(KV("lines", List(sku, text("x"))))
	want := `[{"code":"wrong kind","expected":"GBP","got":"nothing","value":null,"path":["amount"]},` +
		`{"code":"wrong kind","expected":"text","got":"number","value":1,"path":["lines",1,"sku"]},` +
		`{"code":"wrong kind","expected":"map","got":"text","value":"x","path":["lines",2]}]`
	if Conforms(bad, invoice) {
		t.Fatal("a mismatch should not conform")
	}
	if got := encoded(t, Explain(bad, invoice)); got != want {
		t.Fatalf("explain = %s", got)
	}
	union := encoded(t, Explain(Int(3), Optional(OneOf(TextShape, BoolShape))))
	wantUnion := `[{"code":"wrong kind","expected":"text or boolean or nothing","got":"number","value":3,` +
		`"alternatives":[[{"code":"wrong kind","expected":"text","got":"number","value":3}],` +
		`[{"code":"wrong kind","expected":"boolean","got":"number","value":3}]]}]`
	if union != wantUnion {
		t.Fatalf("union explain = %s", union)
	}
}

func must(v Value, err error) Value {
	if err != nil {
		panic(err)
	}
	return v
}

func mustDec(v Value) Decimal {
	d, ok := v.AsDec()
	if !ok {
		panic("not a number")
	}
	return d
}

func encoded(t *testing.T, v Value) string {
	t.Helper()
	b, err := EncodeValue(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
