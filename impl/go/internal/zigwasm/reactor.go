// Package zigwasm owns the embedded Zig reactor and its guest memory.
package zigwasm

import (
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
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
	cache    wazero.CompilationCache
}

// CacheDirEnv names a directory where compiled guest code is kept between
// processes. Unset, every process compiles the artifact itself. wazero keys
// the cache by its version and the artifact, so a changed artifact compiles
// again.
const CacheDirEnv = "NORTHTALK_ZIG_CACHE_DIR"

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
	config := wazero.NewRuntimeConfig()
	var cache wazero.CompilationCache
	if dir := os.Getenv(CacheDirEnv); dir != "" {
		var err error
		if cache, err = wazero.NewCompilationCacheWithDir(dir); err != nil {
			return nil, err
		}
		config = config.WithCompilationCache(cache)
	}
	e := &Engine{runtime: wazero.NewRuntimeWithConfig(ctx, config), cache: cache}
	if _, err := wasi_snapshot_preview1.Instantiate(ctx, e.runtime); err != nil {
		e.Close(ctx)
		return nil, err
	}
	c, err := e.runtime.CompileModule(ctx, wasm)
	if err != nil {
		e.Close(ctx)
		return nil, err
	}
	e.compiled = c
	return e, nil
}
func (e *Engine) Close(ctx context.Context) error {
	err := e.runtime.Close(ctx)
	if e.cache != nil {
		e.cache.Close(ctx)
	}
	return err
}
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
	mu                   sync.Mutex
	module               api.Module
	inline               *inlineIO
	buffer               api.Function
	send                 api.Function
	chunkSend, replyNext api.Function
	chunkSize            int
	// The input buffer talk_buffer last reserved, which lasts until the
	// next talk_buffer, so frames that fit reuse it without that export.
	input, reserved uint32
	// Each export takes and returns one value here, without allocating.
	stack [1]uint64
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

// maxFrame bounds each transport chunk; maxMessage bounds reassembly.
const maxFrame = 64 << 20
const maxMessage = 1<<31 - 1
const moreChunks = uint32(1 << 31)

// minReserve is the smallest input buffer reserved, enough for most frames.
const minReserve = 4 << 10

// EnableChunking follows a successful hello requesting chunked-wasi-v1.
func (r *Reactor) EnableChunking() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.chunkSend = r.module.ExportedFunction("talk_send_chunk")
	r.replyNext = r.module.ExportedFunction("talk_reply_next")
	if r.chunkSend == nil || r.replyNext == nil {
		return fmt.Errorf("guest omits chunked WASI exports")
	}
	r.chunkSize = maxFrame
	if r.inline != nil {
		r.inline.chunked = true
	}
	return nil
}

func (r *Reactor) Frame(ctx context.Context, frame []byte) ([]byte, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	limit := maxFrame
	if r.chunkSize != 0 {
		limit = maxMessage
	}
	if len(frame) == 0 || len(frame) > limit {
		return nil, fmt.Errorf("frame length %d outside 1..%d bytes", len(frame), limit)
	}
	size := len(frame)
	send := r.send
	if r.chunkSize != 0 {
		size = min(size, r.chunkSize)
		send = r.chunkSend
	}
	if uint32(size) > r.reserved {
		size = max(size, minReserve)
		r.stack[0] = uint64(size)
		if err := r.buffer.CallWithStack(ctx, r.stack[:]); err != nil {
			return nil, err
		}
		if r.stack[0] == 0 {
			return nil, fmt.Errorf("talk_buffer refused frame")
		}
		r.input, r.reserved = uint32(r.stack[0]), uint32(size)
	}
	for at := 0; at < len(frame); {
		n := len(frame) - at
		if r.chunkSize != 0 {
			n = min(n, r.chunkSize)
		}
		if !r.module.Memory().Write(r.input, frame[at:at+n]) {
			return nil, fmt.Errorf("input buffer outside guest memory")
		}
		at += n
		count := uint32(n)
		if at < len(frame) {
			count |= moreChunks
		}
		r.stack[0] = uint64(count)
		err := send.CallWithStack(ctx, r.stack[:])
		if r.inline != nil && r.inline.err != nil {
			return nil, r.inline.err
		}
		if err != nil {
			return nil, err
		}
		if at < len(frame) && r.stack[0] != 0 {
			return nil, fmt.Errorf("guest replied before final input chunk")
		}
	}
	var result []byte
	for {
		count := uint32(r.stack[0])
		more := r.chunkSize != 0 && count&moreChunks != 0
		if r.chunkSize != 0 {
			count &^= moreChunks
		}
		if count == 0 || r.chunkSize != 0 && count > maxFrame || int64(len(result))+int64(count) > maxMessage {
			return nil, fmt.Errorf("invalid reply chunk length %d", count)
		}
		reply, ok := r.module.Memory().Read(uint32(r.stack[0]>>32), count)
		if !ok {
			return nil, fmt.Errorf("reply outside guest memory")
		}
		result = append(result, reply...)
		if !more {
			return result, nil
		}
		r.stack[0] = 0
		if err := r.replyNext.CallWithStack(ctx, r.stack[:]); err != nil {
			return nil, err
		}
	}
}
