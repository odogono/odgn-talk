// Package zigprobe investigates a Go Host over the Zig Message Layer.
// It is a transport probe, not a replacement for the public Go embedding API.
package zigprobe

import (
	"context"
	_ "embed"
	"fmt"
	"sync"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
	"github.com/tetratelabs/wazero/imports/wasi_snapshot_preview1"
)

//go:embed talk.wasm
var wasm []byte

// Engine shares compiled code, but each Reactor has independent guest memory.
// Close reactors before closing their Engine.
type Engine struct {
	runtime  wazero.Runtime
	compiled wazero.CompiledModule
}

func NewEngine(ctx context.Context) (*Engine, error) {
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
	m, err := e.runtime.InstantiateModule(ctx, e.compiled, wazero.NewModuleConfig().WithName("").WithStartFunctions("_initialize"))
	if err != nil {
		return nil, err
	}
	return &Reactor{module: m}, nil
}

// Reactor serializes exports, including buffer copies and Close. The caller
// must also serialize complete need/result exchanges; a mutex per frame does
// not make an interleaved Message Layer conversation valid. No Host callback
// runs under this lock. Returned bytes are owned by Go and survive memory.grow.
type Reactor struct {
	mu     sync.Mutex
	module api.Module
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
func (r *Reactor) Frame(ctx context.Context, frame []byte) ([]byte, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(frame) == 0 || len(frame) > 64<<20 {
		return nil, fmt.Errorf("frame length %d outside 1..64 MiB", len(frame))
	}
	allocated, err := r.module.ExportedFunction("talk_buffer").Call(ctx, uint64(len(frame)))
	if err != nil {
		return nil, err
	}
	if len(allocated) != 1 || allocated[0] == 0 {
		return nil, fmt.Errorf("talk_buffer refused frame")
	}
	if !r.module.Memory().Write(uint32(allocated[0]), frame) {
		return nil, fmt.Errorf("input buffer outside guest memory")
	}
	result, err := r.module.ExportedFunction("talk_send").Call(ctx, uint64(len(frame)))
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
