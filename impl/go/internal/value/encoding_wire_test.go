package value

import "testing"

func TestWireCoreMessageProvenance(t *testing.T) {
	raw := []byte(`[{"$coreMessage":{"code":"mine","message":"wording"}},{"$map":[["$coreMessage",{"message":"literal"}]]}]`)
	v, err := DecodeWire(raw, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	items := v.Items()
	if !items[0].CoreMessage || items[1].CoreMessage || items[1].Entries()[0].Val.CoreMessage {
		t.Fatal("provenance confused with a literal map key", v)
	}
	if got := items[0].Get("message").Text(); got != "wording" {
		t.Fatal("wire metadata removed message value", got)
	}
	if _, err := Decode(raw, true, nil); err == nil {
		t.Fatal("storage accepted a wire-only provenance tag")
	}
	for _, raw := range []string{`{"$coreMessage":null}`, `{"$coreMessage":[]}`, `{"$coreMessage":"wording"}`} {
		if _, err := DecodeWire([]byte(raw), nil, nil); err == nil {
			t.Fatal("accepted malformed provenance tag", raw)
		}
	}
}
