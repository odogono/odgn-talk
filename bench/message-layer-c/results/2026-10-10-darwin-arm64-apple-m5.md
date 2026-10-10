# C Host on Wasmtime: 2026-10-10

Descriptive measurements for [#552](https://github.com/odogono/odgn-talk/issues/552),
part of [#532](https://github.com/odogono/odgn-talk/issues/532). No thresholds were
applied; the decision whether this is sufficient for a C Host remains open.

The reactor is commit `4d076d8bebc82c84369acd959ed8ea89ac649c27`, from
[PR #557](https://github.com/odogono/odgn-talk/pull/557). The Host is identified by
source and executable hashes in the [raw observations](2026-10-10-darwin-arm64-apple-m5.json).
The [harness guide](../README.md) defines timing boundaries, warmups and limits.

Machine: Apple M5, arm64, macOS 27.0.1; Go 1.27.2, Apple clang 21.0.0, Wasmtime
C API 49.0.2, cJSON 1.7.19. The stripped reactor is built with
`GOOS=wasip1 GOARCH=wasm -buildmode=c-shared -trimpath -buildvcs=false -ldflags='-s -w'`.
Its SHA-256 is `803151709641c3d9783a74972440b0e3dcaee362b55119b1edf8a3ba4c056080`.

## Timings

Seven samples of 1,000 iterations each; Capability workloads have 1,000
immediate echo calls per Pump. Values below are medians of sample averages,
with the minimum and maximum sample averages. Startup has eight individual
observations instead. These ranges are not individual-call latency percentiles.

| Measurement | Median | Observed range |
| --- | ---: | ---: |
| Idle Pump | 27.80 µs | 23.81–28.73 µs |
| Empty Handler Pump | 62.49 µs | 60.50–63.05 µs |
| Immediate echo, number | 36.07 µs/call | 30.79–36.40 µs/call |
| Immediate echo, nested Value Encoding | 91.53 µs/call | 90.76–96.30 µs/call |
| Instantiate + initialize + first hello | 0.976 ms | 0.940–1.108 ms |

Raw WASM compilation was **1,178.33 ms**, measured once with a fresh Engine.
It is excluded from instantiation. Capability timings include Script execution
and the full JSON/Value Encoding exchange, with initial Pump and final reply
costs amortized. They do not isolate the Wasmtime export boundary.

## Payload and memory

| Payload | Bytes |
| --- | ---: |
| Raw | 12,299,060 |
| gzip 9, zero timestamp | 2,943,787 |
| Brotli 11, lgwin 22 | 2,090,654 |

Both compressed payloads were decompressed and checked against the artifact.

Eight instances were retained simultaneously after warming and deleting one
throwaway instance. Each initialized instance had **7.00 MiB linear memory**.
The observed RSS increment was **6.03 MiB per instance** (6,326,272 bytes).
The warmed process baseline was **514.19 MiB**, rising to **562.45 MiB** with
the eight instances. This substantial baseline includes compilation/runtime
state; the per-instance increment alone does not describe deployment memory.
Allocator reuse and shared pages affect these observations.

The working instance's linear memory grew to **31.00 MiB** by the end of the
workloads and fault checks. This is its capacity at that point, not a live
heap measurement or a steady-state maximum. Wasmtime's virtual reservations
are not reported as resident memory.

## Fault checks

The same instance completed all of these checks without a Wasmtime trap:

- Ten infinite loops ended in a `fuel` Limit Fault at 5,000 Fuel.
- Ten deliberate `throw`s produced `errored` Run Reports with code `deliberate`.
- Ten non-tail-recursive calls ended in a `depth` Limit Fault.
- Malformed JSON and an unknown message produced protocol errors; invalid Bytes
  Value Encoding produced a Host error; unresolved source names produced a load error.

After every case, both `hello` and a healthy Handler returning 42 succeeded on
that same instance. Representative fault Reports are in the raw JSON.
AddressSanitizer and UndefinedBehaviorSanitizer also passed a smaller Host run
(one sample, ten iterations, two instances). LeakSanitizer is unavailable on
this macOS setup, so leak detection was disabled for that check.

These are finite test cases, not a proof that every hostile input is safe.
The 256 MiB Store backstop was not exhausted; a Go runtime OOM there can still
trap. Immediate identity Operations, the supported Message Layer subset, and
this single machine are the scope of these measurements.
