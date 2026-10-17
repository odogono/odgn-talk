//go:build talk_zig_experimental

package northtalk

import (
	"strings"
	"testing"
)

func TestZigBackendReplyRefusesMalformedFrames(t *testing.T) {
	for _, frame := range []string{``, `{`, `{"a"}`, `{"a":1,}`, `[1 2]`, `{"a":01}`, `{"a":1.}`, `"\x"`, "\"\x01\"", `{"a":tru}`, `{} {}`, "\"\xff\"", `{"a":"\u12"}`} {
		if _, err := zigParseReply([]byte(frame)); err == nil {
			t.Errorf("accepted %q", frame)
		}
	}
}

func TestZigBackendReplyReadsEnvelopeInPlace(t *testing.T) {
	// %u stands for a JSON \u escape: "%u00e9" is é, "k%u0065y" is key.
	frame := strings.ReplaceAll(` {"ref":7, "ok":{"n":-12,"t":"a\"b%u00e9","b":true,"l":[1,{"x":[]},"]"],"z":null}, "k%u0065y":"v"} `, "%u", "\\"+"u")
	root, err := zigParseReply([]byte(frame))
	if err != nil {
		t.Fatal(err)
	}
	packet := zigReadPacket(root)
	if n, ok := packet.ref.int64(); !ok || n != 7 {
		t.Fatalf("ref %q", packet.ref)
	}
	ok := packet.ok
	if n, _ := ok.get("n").int64(); n != -12 {
		t.Errorf("n %q", ok.get("n"))
	}
	if s := zigText(ok.get("t")); s != `a"bé` {
		t.Errorf("t %q", s)
	}
	if b, _ := ok.get("b").boolean(); !b {
		t.Errorf("b %q", ok.get("b"))
	}
	items := ok.get("l").items()
	if len(items) != 3 || string(items[1]) != `{"x":[]}` || zigText(items[2]) != "]" {
		t.Errorf("l %q", items)
	}
	if ok.get("z").present() || ok.get("missing").present() || packet.err.present() {
		t.Error("null or absent member is present")
	}
	if zigText(root.get("key")) != "v" {
		t.Error("escaped key not found")
	}
}

// ADR 0088: a deep payload is validated and skipped without recursion, and
// left for the Value Encoding reader.
func TestZigBackendReplyToleratesDeepPayloads(t *testing.T) {
	const depth = 100_000
	deep := strings.Repeat("[", depth) + strings.Repeat("]", depth)
	root, err := zigParseReply([]byte(`{"ok":{"value":` + deep + `,"after":1},"ref":1}`))
	if err != nil {
		t.Fatal(err)
	}
	packet := zigReadPacket(root)
	if len(packet.ok.get("value")) != 2*depth {
		t.Fatal("deep payload span")
	}
	if n, _ := packet.ok.get("after").int64(); n != 1 {
		t.Fatal("member after a deep payload")
	}
	if n, _ := packet.ref.int64(); n != 1 {
		t.Fatal("ref after a deep payload")
	}
}
