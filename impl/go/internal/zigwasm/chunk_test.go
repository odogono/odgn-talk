package zigwasm

import (
	"bytes"
	"context"
	"testing"
)

func TestChunkedInput(t *testing.T) {
	ctx := context.Background()
	engine, err := NewEngine(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	defer engine.Close(ctx)
	guest, err := engine.Instantiate(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer guest.Close(ctx)
	reply, err := guest.Frame(ctx, []byte(`{"m":"hello","ref":1,"protocol":1,"features":["chunked-wasi-v1"]}`))
	if err != nil || !bytes.Contains(reply, []byte(`"ok"`)) {
		t.Fatalf("hello: %s, %v", reply, err)
	}
	if err := guest.EnableChunking(); err != nil {
		t.Fatal(err)
	}
	// Deliberately split syntax and UTF-8 across chunks. Padding is ignored by
	// the dispatcher; its size proves the old input admission cap is crossed.
	frame := []byte(`{"m":"hello","ref":2,"protocol":1,"padding":"`)
	// Choose an odd offset within the two-byte padding scalars.
	guest.chunkSize = (1 << 20) + len(frame)%2 + 1
	frame = append(frame, bytes.Repeat([]byte("é"), maxFrame/2)...)
	frame = append(frame, []byte(`"}`)...)
	reply, err = guest.Frame(ctx, frame)
	if err != nil || !bytes.Contains(reply, []byte(`"ref":2,"ok"`)) {
		t.Fatalf("large input: %.200s, %v", reply, err)
	}
	// A malformed completed message must leave the Session usable.
	reply, err = guest.Frame(ctx, []byte(`{"m":`))
	if err != nil || !bytes.Contains(reply, []byte(`"protocol error"`)) {
		t.Fatalf("malformed: %s, %v", reply, err)
	}
	reply, err = guest.Frame(ctx, []byte(`{"m":"hello","ref":3,"protocol":1}`))
	if err != nil || !bytes.Contains(reply, []byte(`"ref":3,"ok"`)) {
		t.Fatalf("reused: %s, %v", reply, err)
	}
}

func TestChunkedInlineAdmission(t *testing.T) {
	ctx := context.Background()
	engine, err := NewEngine(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	defer engine.Close(ctx)
	admission := []byte(`{"m":"queued-inputs","ref":91,"group":"g","padding":"`)
	admission = append(admission, bytes.Repeat([]byte("x"), maxFrame)...)
	admission = append(admission, []byte(`"}`)...)
	sent, acknowledged := false, false
	guest, err := engine.InstantiateObserved(ctx, func(event []byte) ([]byte, error) {
		if !sent {
			sent = true
			return admission, nil
		}
		if bytes.Contains(event, []byte(`"reply":{"ref":91,"ok":{"queued":false}`)) {
			acknowledged = true
		}
		return []byte("null"), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer guest.Close(ctx)
	hello := []byte(`{"m":"hello","ref":1,"protocol":1,"features":["chunked-wasi-v1","inline-inputs-v1","queued-inputs-v1"]}`)
	reply, err := guest.Frame(ctx, hello)
	if err != nil || !bytes.Contains(reply, []byte(`"ok"`)) {
		t.Fatalf("hello: %s, %v", reply, err)
	}
	if err := guest.EnableChunking(); err != nil {
		t.Fatal(err)
	}
	for _, frame := range []string{
		`{"m":"new-group","ref":2,"group":"g","trace":true}`,
		`{"m":"load","ref":3,"group":"g","name":"s","source":"script variable n = 1"}`,
	} {
		reply, err = guest.Frame(ctx, []byte(frame))
		if err != nil || !bytes.Contains(reply, []byte(`"ok"`)) {
			t.Fatalf("frame: %s, %v", reply, err)
		}
	}
	if !sent || !acknowledged {
		t.Fatalf("large inline admission: sent=%t acknowledged=%t", sent, acknowledged)
	}
}
