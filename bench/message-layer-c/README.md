# Message Layer from a C Host

This standalone C Host measures the Go Core's WASI Preview 1 reactor through
the Wasmtime C API for [#552](https://github.com/odogono/odgn-talk/issues/552),
part of [#532](https://github.com/odogono/odgn-talk/issues/532). It uses the
ordinary Message Layer, including interim `op` / `op-result` exchanges.
Measurements are descriptive; no pass/fail thresholds are applied.

The [2026-10-10 Apple M5 results](results/2026-10-10-darwin-arm64-apple-m5.md)
record the first run, with raw samples and provenance.

## Run

Install Go 1.27, a C11 compiler, Python 3, Brotli's CLI, and Wasmtime's **C API**
headers and library. On macOS, `brew install wasmtime brotli` provides the latter
two. On Linux, set `WASMTIME_PREFIX` to the unpacked Wasmtime C API release
directory. The CLI alone is insufficient. RSS measurement supports macOS and
Linux with `/proc`.

From the repository root, after the reactor in #551 is available:

```sh
bench/message-layer-c/run.sh
```

The runner builds with `GOOS=wasip1 GOARCH=wasm`, `-buildmode=c-shared`,
`-trimpath -buildvcs=false -ldflags='-s -w'` (the Go guide's stripped release build),
then compiles and runs the C Host. It downloads cJSON 1.7.19 from upstream into
ignored `out/cjson/` and verifies both source files' SHA-256 hashes. The MIT
licence is included in the upstream source headers.

To measure an existing reactor without changing this checkout:

```sh
REACTOR_REVISION='<commit or explicit uncommitted-source description>' \
REACTOR_SOURCE='/absolute/path/to/main_wasip1.go' \
  bench/message-layer-c/run.sh /absolute/path/to/messagelayer.wasm
```

`REACTOR_SOURCE` optionally records that source file's hash; the WASM hash is
always recorded. External builds should identify their revision and build
flags; `REACTOR_BUILD_FLAGS` records flags for an external build. Relative paths
are resolved from this directory. Results are written to `out/measurements.json`,
including provenance, versions, machine, payload
sizes and raw samples. Copy that file to `results/` when recording a measurement.

Defaults are seven timing samples, 1,000 iterations per sample, and eight
simultaneously live instances. Override `SAMPLES`, `ITERATIONS`, `INSTANCES`,
`WASMTIME_PREFIX`, `CC`, `CFLAGS`, or `LDFLAGS`. A quick check is:

```sh
SAMPLES=1 ITERATIONS=10 INSTANCES=2 bench/message-layer-c/run.sh
```

## Measurements

- **Compilation:** one raw WASM compilation with a fresh Engine, separately
  from instance creation. No compilation cache is configured.
- **Instantiation:** a fresh Store and WASI context, instantiation, `_initialize`,
  export lookup, and the first `hello` exchange, against the compiled Module.
  One throwaway instance warms the runtime before the recorded instances.
- **Memory:** exported linear-memory size after initialization and `hello`, and
  process RSS before/after retaining the instances, divided by their count.
  The warmed process baseline is also recorded. RSS increments are affected by
  allocator reuse and shared pages. Linear memory is distinct from RSS and
  Wasmtime's virtual address-space reservations.
- **Idle Pump:** an empty Group's Pump, including C JSON construction, encoding,
  both exports, memory copies, Go processing and C reply parsing/deletion.
- **Empty Handler Pump:** one previously queued Delivery completed by one Pump,
  including Report conversion. Delivery, final outcome validation and final
  reply deletion are outside the interval.
- **Capability calls:** one Pump executing `ITERATIONS` immediate identity
  Operations. The interval includes Script execution and each interim exchange:
  Go Value Encoding, C JSON parsing, copying the argument, re-encoding it into
  `op-result`, and Go decoding. `number` and `nested_value` arrays are
  microseconds per call, with the initial Pump/final reply amortized. These are
  inclusive workload costs. Delivery, final validation and final reply deletion
  are outside the interval. Each workload has an unrecorded warmup sample.
- **Payload:** raw bytes, gzip level 9 with zero timestamp, and Brotli quality 11
  with `lgwin=22`, matching the Go guide's Python measurement. Both compressed
  forms are decoded and checked against the original artifact.

The nested value includes a list, text, boolean, Nothing, a 24-digit decimal
with trailing zeros, a Quantity and Bytes. Tagged decimals preserve precision
despite cJSON's numeric representation; untagged integers are below 2⁵³. The
returned JSON must match the input, including key order and tags. Every Pump
must make exactly the requested number of calls. Trace recording is disabled.
This identity Host is not a reusable C binding.

## Fault evidence and limits

The same instance runs ten fuel-exhaustion cases, ten deliberate `throw`s,
and ten non-tail-recursive depth faults. It then rejects malformed JSON, an
unknown message, malformed Value Encoding, and a source load error. After
**each** case, `hello` and a healthy Handler returning 42 must succeed on that
instance. Representative Run Reports are recorded. Any Wasmtime error/trap,
wrong error/outcome, or failed reuse check causes a nonzero exit.

These inputs provide evidence, not a proof about all hostile Scripts. The Store
has a 256 MiB linear-memory backstop, separate from Script budgets. Go runtime
OOM at that backstop can trap and is not tested as a Script fault. Capability
timing covers immediate Operations, not external I/O, suspending Operations,
restore, or unsupported messages. See the [Go guide](../../impl/go/README.md#message-layer)
for the supported message set. Wasmtime setup follows its
[WASIp1 C example](https://docs.wasmtime.dev/examples-wasip1.html).
