// Package zigwasm owns the embedded Zig reactor and its guest memory.
package zigwasm

import (
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sync"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
	"github.com/tetratelabs/wazero/experimental"
	"github.com/tetratelabs/wazero/imports/wasi_snapshot_preview1"
)

//go:embed talk.wasm
var wasm []byte

//go:embed artifact.json
var manifest []byte

// Engine shares compiled code, but each Reactor has independent guest memory.
// Close reactors before closing their Engine.
type Engine struct {
	runtime  wazero.Runtime
	compiled wazero.CompiledModule
}

func NewEngine(ctx context.Context) (*Engine, error) {
	var recorded struct {
		SHA256 string `json:"sha256"`
	}
	if err := json.Unmarshal(manifest, &recorded); err != nil {
		return nil, err
	}
	sum := sha256.Sum256(wasm)
	if hex.EncodeToString(sum[:]) != recorded.SHA256 {
		return nil, fmt.Errorf("embedded Zig artifact digest mismatch")
	}
	r := wazero.NewRuntime(ctx)
	if _, err := wasi_snapshot_preview1.Instantiate(ctx, r); err != nil {
		r.Close(ctx)
		return nil, err
	}
	c, err := r.CompileModule(ctx, wasm)
	if err != nil {
		r.Close(ctx)
		return nil, err
	}
	return &Engine{r, c}, nil
}
func (e *Engine) Close(ctx context.Context) error { return e.runtime.Close(ctx) }
func (e *Engine) Instantiate(ctx context.Context) (*Reactor, error) {
	return e.InstantiateObserved(ctx, nil)
}

func (e *Engine) InstantiateObserved(ctx context.Context, observer func([]byte) ([]byte, error)) (*Reactor, error) {
	config := wazero.NewModuleConfig().WithName("").WithStartFunctions("_initialize")
	var inline *inlineIO
	if observer != nil {
		inline = &inlineIO{event: observer}
		config = config.WithStdin(inline).WithStdout(inline)
	}
	m, err := e.runtime.InstantiateModule(experimental.WithMemoryAllocator(ctx, experimental.MemoryAllocatorFunc(allocate)), e.compiled, config)
	if err != nil {
		return nil, err
	}
	// Looking an export up per call builds a new call engine and stack each time.
	return &Reactor{module: m, inline: inline, buffer: m.ExportedFunction("talk_buffer"), send: m.ExportedFunction("talk_send")}, nil
}

// Reactor serializes exports, including buffer copies and Close. The caller
// must also serialize complete need/result exchanges; a mutex per frame does
// not make an interleaved Message Layer conversation valid. Inline I/O services
// admission on the active export's stack; Host sink jobs use the adapter queue
// and must not call Reactor exports. Returned bytes survive memory.grow.
type Reactor struct {
	mu     sync.Mutex
	module api.Module
	inline *inlineIO
	buffer api.Function
	send   api.Function
}

func (r *Reactor) Close(ctx context.Context) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.module.Close(ctx)
}
func (r *Reactor) MemoryBytes() uint32 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.module.Memory().Size()
}

// maxFrame bounds every transport frame and inline event.
const maxFrame = 64 << 20

func (r *Reactor) Frame(ctx context.Context, frame []byte) ([]byte, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(frame) == 0 || len(frame) > maxFrame {
		return nil, fmt.Errorf("frame length %d outside 1..64 MiB", len(frame))
	}
	allocated, err := r.buffer.Call(ctx, uint64(len(frame)))
	if err != nil {
		return nil, err
	}
	if len(allocated) != 1 || allocated[0] == 0 {
		return nil, fmt.Errorf("talk_buffer refused frame")
	}
	if !r.module.Memory().Write(uint32(allocated[0]), frame) {
		return nil, fmt.Errorf("input buffer outside guest memory")
	}
	result, err := r.send.Call(ctx, uint64(len(frame)))
	if r.inline != nil && r.inline.err != nil {
		return nil, r.inline.err
	}
	if err != nil {
		return nil, err
	}
	if len(result) != 1 {
		return nil, fmt.Errorf("talk_send returned %d values", len(result))
	}
	reply, ok := r.module.Memory().Read(uint32(result[0]>>32), uint32(result[0]))
	if !ok {
		return nil, fmt.Errorf("reply outside guest memory")
	}
	return append([]byte(nil), reply...), nil
}
