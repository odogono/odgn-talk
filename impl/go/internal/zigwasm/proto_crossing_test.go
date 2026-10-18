package zigwasm

// PROTOTYPE, #1103 spike only; not for main. It measures the guest-side floor
// of a Request round trip, with no public-API adapter, against a guest built
// from spike/zig-request-crossing-1103:
//
//	(cd impl/zig && zig build -Dtarget=wasm32-wasi -p /tmp/odgn-1103-spike)
//	NORTHTALK_PROTO_GUEST=/tmp/odgn-1103-spike/bin/talk.wasm \
//	  go -C impl/go test ./internal/zigwasm -run '^$' -bench BenchmarkProtoCrossing

import (
	"bytes"
	"context"
	"os"
	"testing"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/imports/wasi_snapshot_preview1"
)

func BenchmarkProtoCrossing(b *testing.B) {
	path := os.Getenv("NORTHTALK_PROTO_GUEST")
	if path == "" {
		b.Skip("set NORTHTALK_PROTO_GUEST to the spike guest")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		b.Fatal(err)
	}
	ctx := context.Background()
	rt := wazero.NewRuntime(ctx)
	defer rt.Close(ctx)
	if _, err := wasi_snapshot_preview1.Instantiate(ctx, rt); err != nil {
		b.Fatal(err)
	}
	compiled, err := rt.CompileModule(ctx, data)
	if err != nil {
		b.Fatal(err)
	}
	engine := &Engine{runtime: rt, compiled: compiled}
	setup := func(b *testing.B) (*Reactor, func([]byte) []byte) {
		reactor, err := engine.InstantiateObserved(ctx, func([]byte) ([]byte, error) { return []byte("null"), nil })
		if err != nil {
			b.Fatal(err)
		}
		send := func(data []byte) []byte {
			reply, err := reactor.Frame(ctx, data)
			if err != nil || bytes.Contains(reply, []byte(`"err"`)) {
				b.Fatalf("%s: %s %v", data, reply, err)
			}
			return reply
		}
		send([]byte(`{"m":"hello","ref":1,"protocol":1,"features":["paused-inputs-v1","abandoned-before-needs-v1","crossing-trace-v1","climb-v1","function-gone-v1","function-metadata-v1","core-message-v1","standard-refinements-v1","inline-inputs-v1","restore-bindings-v1","group-exchanges-v1","queued-inputs-v1"]}`))
		send([]byte(`{"m":"new-group","ref":2,"group":"g","name":"request","trace":false}`))
		send([]byte(`{"m":"load","ref":3,"group":"g","name":"s","source":"on ping n\n return n + 1\nend ping\n"}`))
		return reactor, send
	}
	request := []byte(`{"m":"request","ref":4,"group":"g","to":{"script":"s"},"message":{"name":"ping","args":[41]}}`)
	pump := []byte(`{"m":"pump","ref":5,"group":"g","now":"2026-10-17T12:00:00Z","fuelSlice":0,"fuelCap":0}`)
	combined := []byte(`{"m":"proto-request-pump","ref":6,"group":"g","to":{"script":"s"},"message":{"name":"ping","args":[41]},"now":"2026-10-17T12:00:00Z","fuelSlice":0,"fuelCap":0}`)

	b.Run("empty-export", func(b *testing.B) {
		reactor, _ := setup(b)
		defer reactor.Close(ctx)
		for b.Loop() {
			if _, err := reactor.buffer.Call(ctx, 1); err != nil {
				b.Fatal(err)
			}
		}
	})
	b.Run("json-two-frames", func(b *testing.B) {
		reactor, send := setup(b)
		defer reactor.Close(ctx)
		for b.Loop() {
			send(request)
			if reply := send(pump); !bytes.Contains(reply, []byte(`"result":42`)) {
				b.Fatalf("missing result: %s", reply)
			}
		}
	})
	b.Run("json-one-frame", func(b *testing.B) {
		reactor, send := setup(b)
		defer reactor.Close(ctx)
		for b.Loop() {
			if reply := send(combined); !bytes.Contains(reply, []byte(`"result":42`)) {
				b.Fatalf("missing result: %s", reply)
			}
		}
	})
	for mode, name := range []string{"direct", "direct-json-reports"} {
		b.Run(name, func(b *testing.B) {
			reactor, _ := setup(b)
			defer reactor.Close(ctx)
			ping := reactor.module.ExportedFunction("talk_proto_ping")
			for b.Loop() {
				got, err := ping.Call(ctx, 41, uint64(mode))
				if err != nil || int64(got[0]) != 42 {
					b.Fatalf("ping %v %v", got, err)
				}
			}
		})
	}
}

func TestProtoReplyShape(t *testing.T) {
	path := os.Getenv("NORTHTALK_PROTO_GUEST")
	if path == "" {
		t.Skip("set NORTHTALK_PROTO_GUEST to the spike guest")
	}
	data, _ := os.ReadFile(path)
	ctx := context.Background()
	rt := wazero.NewRuntime(ctx)
	defer rt.Close(ctx)
	wasi_snapshot_preview1.Instantiate(ctx, rt)
	compiled, _ := rt.CompileModule(ctx, data)
	engine := &Engine{runtime: rt, compiled: compiled}
	reactor, _ := engine.InstantiateObserved(ctx, func(e []byte) ([]byte, error) { t.Logf("inline %s", e); return []byte("null"), nil })
	for _, f := range []string{
		`{"m":"hello","ref":1,"protocol":1,"features":["paused-inputs-v1","abandoned-before-needs-v1","crossing-trace-v1","climb-v1","function-gone-v1","function-metadata-v1","core-message-v1","standard-refinements-v1","inline-inputs-v1","restore-bindings-v1","group-exchanges-v1","queued-inputs-v1"]}`,
		`{"m":"new-group","ref":2,"group":"g","name":"request","trace":false}`,
		`{"m":"load","ref":3,"group":"g","name":"s","source":"on ping n\n return n + 1\nend ping\n"}`,
		`{"m":"request","ref":4,"group":"g","to":{"script":"s"},"message":{"name":"ping","args":[41]}}`,
		`{"m":"pump","ref":5,"group":"g","now":"2026-10-17T12:00:00Z","fuelSlice":0,"fuelCap":0}`,
	} {
		reply, err := reactor.Frame(ctx, []byte(f))
		t.Logf("%d bytes: %s %v", len(reply), reply, err)
	}
}
