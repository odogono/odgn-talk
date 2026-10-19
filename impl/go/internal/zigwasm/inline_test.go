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

func TestInlineChunksWaitForCompleteEvent(t *testing.T) {
	var calls int
	transport := inlineIO{chunked: true, event: func(data []byte) ([]byte, error) {
		calls++
		if string(data) != `{"trace":["é"]}` {
			t.Fatalf("event: %q", data)
		}
		return []byte("null"), nil
	}}
	data := []byte(`{"trace":["é"]}`)
	// End a nonfinal chunk halfway through the UTF-8 scalar; framing is bytes.
	split := bytes.Index(data, []byte("é")) + 1
	first := inlineFrame(string(data[:split]))
	binary.BigEndian.PutUint32(first, uint32(split)|moreChunks)
	for _, part := range [][]byte{first[:1], first[1:]} {
		if _, err := transport.Write(part); err != nil {
			t.Fatal(err)
		}
	}
	if calls != 0 || len(transport.read) != 0 {
		t.Fatal("partial event observed or acknowledged")
	}
	if _, err := transport.Write(inlineFrame(string(data[split:]))); err != nil {
		t.Fatal(err)
	}
	if calls != 1 || !bytes.Equal(transport.read, inlineFrame("null")) {
		t.Fatal("missing complete event acknowledgement")
	}
}

func TestInlineChunkFlagsRequireNegotiation(t *testing.T) {
	transport := inlineIO{}
	header := make([]byte, 4)
	binary.BigEndian.PutUint32(header, moreChunks|1)
	if _, err := transport.Write(header); err == nil {
		t.Fatal("continuation accepted without negotiation")
	}
	for _, chunked := range []bool{false, true} {
		transport := inlineIO{chunked: chunked}
		if _, err := transport.Write(make([]byte, 4)); err == nil {
			t.Fatal("empty chunk admitted")
		}
	}
}

func TestInlineLargeResponseIsChunked(t *testing.T) {
	reply := bytes.Repeat([]byte("x"), maxFrame+1)
	transport := inlineIO{chunked: true, event: func([]byte) ([]byte, error) { return reply, nil }}
	if _, err := transport.Write(inlineFrame(`{"poll":true}`)); err != nil {
		t.Fatal(err)
	}
	if got := binary.BigEndian.Uint32(transport.read); got != moreChunks|maxFrame {
		t.Fatalf("first header: %x", got)
	}
	if got := binary.BigEndian.Uint32(transport.read[4+maxFrame:]); got != 1 {
		t.Fatalf("final header: %x", got)
	}
	if !bytes.Equal(transport.read[4:4+maxFrame], reply[:maxFrame]) || transport.read[len(transport.read)-1] != 'x' {
		t.Fatal("response changed")
	}
}
