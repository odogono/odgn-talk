package unicode

import (
	"strings"
	"testing"
)

func TestNFCASCIIAndMixedBoundary(t *testing.T) {
	var ascii strings.Builder
	for cp := byte(0); cp < 128; cp++ {
		ascii.WriteByte(cp)
	}
	text := ascii.String()
	if got, err := NFC(text); err != nil || got != text {
		t.Fatalf("ASCII changed: %q, %v", got, err)
	}
	if got, err := NFC(text + "e\u0301"); err != nil || got != text+"é" {
		t.Fatalf("mixed boundary: %q, %v", got, err)
	}
	if _, err := NFC(text + "\xff"); err == nil {
		t.Fatal("accepted invalid UTF-8 after ASCII prefix")
	}
}

func BenchmarkNFCASCII(b *testing.B) {
	text := strings.Repeat("x", 1<<20)
	b.SetBytes(int64(len(text)))
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		if _, err := NFC(text); err != nil {
			b.Fatal(err)
		}
	}
}
