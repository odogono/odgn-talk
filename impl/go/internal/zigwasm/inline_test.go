package zigwasm

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"testing"
)

func inlineFrame(body string) []byte {
	out := make([]byte, 4+len(body))
	binary.BigEndian.PutUint32(out, uint32(len(body)))
	copy(out[4:], body)
	return out
}

func TestInlineFramingAcrossPartialWritesAndReads(t *testing.T) {
	var events []string
	transport := inlineIO{event: func(data []byte) ([]byte, error) { events = append(events, string(data)); return []byte("null"), nil }}
	input := append(inlineFrame(`{"poll":true}`), inlineFrame(`{"trace":["record"]}`)...)
	for _, part := range [][]byte{input[:2], input[2:7], input[7:]} {
		n, err := transport.Write(part)
		if err != nil || n != len(part) {
			t.Fatal(n, err)
		}
	}
	if len(events) != 2 || events[0] != `{"poll":true}` || events[1] != `{"trace":["record"]}` {
		t.Fatal(events)
	}
	// fd_read can split both the header and body at any byte.
	var got []byte
	for {
		var one [1]byte
		n, err := transport.Read(one[:])
		got = append(got, one[:n]...)
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	want := append(inlineFrame("null"), inlineFrame("null")...)
	if !bytes.Equal(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestInlineFailureIsRetained(t *testing.T) {
	failure := errors.New("observer failed")
	transport := inlineIO{event: func([]byte) ([]byte, error) { return nil, failure }}
	if _, err := transport.Write(inlineFrame(`{"poll":true}`)); !errors.Is(err, failure) {
		t.Fatal(err)
	}
	if _, err := transport.Write(inlineFrame(`{"poll":true}`)); !errors.Is(err, failure) {
		t.Fatal(err)
	}
	oversized := inlineIO{}
	var header [4]byte
	binary.BigEndian.PutUint32(header[:], maxFrame+1)
	if _, err := oversized.Write(header[:]); err == nil {
		t.Fatal("oversized frame admitted")
	}
}
