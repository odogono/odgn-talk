package messagelayer

import (
	"bytes"
	"encoding/binary"
	"io"
	"strings"
	"testing"
)

func TestServeAnswersEachFrame(t *testing.T) {
	var in, out bytes.Buffer
	for _, frame := range []string{`{"m":"hello","ref":1,"protocol":1}`, `{"m":"add","ref":2,"a":1,"b":2}`} {
		if err := WriteFrame(&in, []byte(frame)); err != nil {
			t.Fatal(err)
		}
	}
	if err := Serve(&in, &out); err != nil {
		t.Fatal(err)
	}
	first, err := ReadFrame(&out)
	if err != nil || !strings.HasSuffix(string(first), `"ref":1}`) {
		t.Fatal(string(first), err)
	}
	second, err := ReadFrame(&out)
	if err != nil || string(second) != `{"ok":{"value":3},"ref":2}` {
		t.Fatal(string(second), err)
	}
	if _, err := ReadFrame(&out); err != io.EOF {
		t.Fatal(err)
	}
}

func TestBadFramesEndTheSidecar(t *testing.T) {
	var big [4]byte
	binary.BigEndian.PutUint32(big[:], MaxFrame+1)
	for name, in := range map[string][]byte{"header": {0, 0}, "body": {0, 0, 0, 9, '{'}, "length": big[:]} {
		if err := Serve(bytes.NewReader(in), io.Discard); err == nil {
			t.Fatal(name, "accepted")
		}
	}
}
