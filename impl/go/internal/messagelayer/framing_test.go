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

func TestServeDrainsOversizedFrameAndContinues(t *testing.T) {
	var header [4]byte
	binary.BigEndian.PutUint32(header[:], MaxFrame+1)
	var before, next, out bytes.Buffer
	for buffer, frame := range map[*bytes.Buffer]string{
		&before: `{"m":"new-group","ref":0,"group":"g","name":"g"}`,
		&next:   `{"m":"load","ref":1,"group":"g","name":"s","source":""}`,
	} {
		if err := WriteFrame(buffer, []byte(frame)); err != nil {
			t.Fatal(err)
		}
	}
	if err := WriteFrame(&next, []byte(`{"m":"add","ref":2,"a":1,"b":2}`)); err != nil {
		t.Fatal(err)
	}
	in := io.MultiReader(&before, bytes.NewReader(header[:]), io.LimitReader(zeroReader{}, MaxFrame+1), &next)
	if err := Serve(in, &out); err != nil {
		t.Fatal(err)
	}
	created, err := ReadFrame(&out)
	if err != nil || !strings.Contains(string(created), `"ok":`) {
		t.Fatal(string(created), err)
	}
	first, err := ReadFrame(&out)
	if err != nil || !strings.Contains(string(first), `"kind":"protocol error"`) || !strings.Contains(string(first), `"ref":-1`) {
		t.Fatal(string(first), err)
	}
	loaded, err := ReadFrame(&out)
	if err != nil || !strings.Contains(string(loaded), `"ok":`) {
		t.Fatal("Session was not preserved", string(loaded), err)
	}
	second, err := ReadFrame(&out)
	if err != nil || string(second) != `{"ok":{"value":3},"ref":2}` {
		t.Fatal(string(second), err)
	}
	if _, err := ReadFrame(&out); err != io.EOF {
		t.Fatal(err)
	}
}

type zeroReader struct{}

func (zeroReader) Read(p []byte) (int, error) {
	clear(p)
	return len(p), nil
}
