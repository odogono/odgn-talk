package zigwasm

import (
	"bytes"
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
	"github.com/tetratelabs/wazero/experimental"
	"github.com/tetratelabs/wazero/imports/wasi_snapshot_preview1"
)

type guestPhaseTimer struct {
	active  bool
	start   []time.Time
	elapsed time.Duration
	calls   int
}

func (p *guestPhaseTimer) Before(context.Context, api.Module, api.FunctionDefinition, []uint64, experimental.StackIterator) {
	if p.active {
		p.start = append(p.start, time.Now())
	}
}
func (p *guestPhaseTimer) After(context.Context, api.Module, api.FunctionDefinition, []uint64) {
	if p.active {
		p.elapsed += time.Since(p.start[len(p.start)-1])
		p.start = p.start[:len(p.start)-1]
		p.calls++
	}
}
func (p *guestPhaseTimer) Abort(context.Context, api.Module, api.FunctionDefinition, error) {}

// TestGuestRequestProfile is an opt-in diagnostic, outside ordinary acceptance.
// It times one function family per guest so listener overhead is bounded and
// nested stages are not mistaken for disjoint percentages. Optimizer-inlined
// functions have no listener calls; zero calls does not imply zero cost.
func TestGuestRequestProfile(t *testing.T) {
	path := os.Getenv("NORTHTALK_PROFILE_GUEST")
	if path == "" {
		t.Skip("set NORTHTALK_PROFILE_GUEST to an unstripped diagnostic guest")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, stage := range []string{"none", "message.sendExport", "json.static.parseFromSlice", "message.decodeValue", "machine.machine.Group.pumpWith", "talk.Group.flush", "message.writeHeld", "message.finishOk", "message.inlinePoll", "message.queuedReply"} {
		t.Run(stage, func(t *testing.T) {
			timer := &guestPhaseTimer{start: make([]time.Time, 0, 16)}
			ctx := experimental.WithFunctionListenerFactory(context.Background(), experimental.FunctionListenerFactoryFunc(func(def api.FunctionDefinition) experimental.FunctionListener {
				if strings.HasPrefix(def.Name(), stage) {
					return timer
				}
				return nil
			}))
			rt := wazero.NewRuntime(ctx)
			defer rt.Close(ctx)
			if _, err := wasi_snapshot_preview1.Instantiate(ctx, rt); err != nil {
				t.Fatal(err)
			}
			compiled, err := rt.CompileModule(ctx, data)
			if err != nil {
				t.Fatal(err)
			}
			engine := &Engine{runtime: rt, compiled: compiled}
			reactor, err := engine.InstantiateObserved(ctx, func([]byte) ([]byte, error) { return []byte("null"), nil })
			if err != nil {
				t.Fatal(err)
			}
			defer reactor.Close(ctx)
			send := func(data []byte) []byte {
				reply, err := reactor.Frame(ctx, data)
				if err != nil || bytes.Contains(reply, []byte(`"err"`)) {
					t.Fatalf("%s: %s %v", data, reply, err)
				}
				return reply
			}
			send([]byte(`{"m":"hello","ref":1,"protocol":1,"features":["paused-inputs-v1","abandoned-before-needs-v1","crossing-trace-v1","climb-v1","function-gone-v1","function-metadata-v1","core-message-v1","standard-refinements-v1","inline-inputs-v1","restore-bindings-v1","group-exchanges-v1","queued-inputs-v1"]}`))
			send([]byte(`{"m":"new-group","ref":2,"group":"g","name":"request"}`))
			send([]byte(`{"m":"load","ref":3,"group":"g","name":"s","source":"on ping n\n return n + 1\nend ping\n"}`))
			request := []byte(`{"m":"request","ref":4,"group":"g","to":{"script":"s"},"message":{"name":"ping","args":[41]}}`)
			pump := []byte(`{"m":"pump","ref":5,"group":"g","now":"2026-10-17T12:00:00Z"}`)
			for i := 0; i < 1000; i++ {
				send(request)
				send(pump)
			}
			const iterations = 20000
			timer.active = true
			start := time.Now()
			for i := 0; i < iterations; i++ {
				send(request)
				reply := send(pump)
				if !bytes.Contains(reply, []byte(`"result":42`)) {
					t.Fatalf("missing result: %s", reply)
				}
			}
			elapsed := time.Since(start)
			timer.active = false
			t.Logf("STAGE %s total_ns/op=%.0f measured_ns/op=%.0f calls/op=%.1f", stage, float64(elapsed.Nanoseconds())/iterations, float64(timer.elapsed.Nanoseconds())/iterations, float64(timer.calls)/iterations)
		})
	}
}
