package northtalk

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"

	corevalue "northtalk.org/go/internal/value"
)

func TestZigBackendSharedBinaryVectors(t *testing.T) {
	data, err := os.ReadFile("../testdata/request-pump-binary.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct{ JSON, Hex string }
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	b := &zigGroup{}
	for _, vector := range vectors {
		t.Run(vector.JSON, func(t *testing.T) {
			want, err := hex.DecodeString(vector.Hex)
			if err != nil {
				t.Fatal(err)
			}
			v, err := corevalue.Decode([]byte(vector.JSON), true, nil)
			if err != nil {
				t.Fatal(err)
			}
			w := &zbWriter{}
			if err := b.zbValue(w, Value{v}); err != nil || !bytes.Equal(w.buf, want) {
				t.Fatalf("encode: %x want %x: %v", w.buf, want, err)
			}
			r := zbReader{d: want}
			span, err := r.skip()
			if err != nil || r.at != len(want) {
				t.Fatalf("envelope: %x: %v", want, err)
			}
			back, err := b.zbDecodeValue(span)
			if err != nil || !back.Equal(Value{v}) {
				t.Fatalf("decode: %v: %v", back, err)
			}
		})
	}
}

func TestZigBackendBinaryIntegerBounds(t *testing.T) {
	for _, wire := range []string{
		"1000",                     // Negative zero.
		"1081808080808080808002",   // Magnitude 2^64 + 1.
		"1080808080808080808003",   // Magnitude above 2^64.
		"108080808080808080808200", // Overlong magnitude 2^64.
		"10808080808080808080",     // Truncated magnitude.
		"1080808080808080808080",   // Unterminated magnitude.
		"0380808080808080808002",   // Positive 2^64.
		"0b80808080808080808002",   // Instant above uint64.
		"0680808080808080808002",   // List count above uint64.
	} {
		t.Run(wire, func(t *testing.T) {
			data, err := hex.DecodeString(wire)
			if err != nil {
				t.Fatal(err)
			}
			r := zbReader{d: data}
			if _, err := r.skip(); err == nil {
				t.Fatal("accepted malformed integer")
			}
		})
	}
	boundary, _ := hex.DecodeString("1080808080808080808002")
	if _, ok := zbInt(boundary); ok {
		t.Fatal("accepted -2^64 in an int64 field")
	}
}
