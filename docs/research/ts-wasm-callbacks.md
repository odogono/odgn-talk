# TS Host binary callbacks (#1314)

Measurements and verification on 2026-10-19 for the TS Host's
[`callbacks-fields-v1` implementation](../../impl/ts/src/request-pump-binary.ts),
against the legacy JSON callback layout. The protocol is already specified in
[Callback needs and results](../../spec/embedding/request-pump-binary.md#callback-needs-and-results).
This changes the TS Host; it does not change the guest, language or Corpus expectations.

## Measurement

The [measurement program](../../bench/ts/src/wasm-callbacks.ts) runs the shared
`host/immediate` and `host/properties` Scripts with 1,000 callbacks per Run.
It times Pump alone, validates every result, and records Fuel and logical
allocation. Admission, compilation, Group creation and Object setup are outside
timing. Both layouts keep Request/Pump binary enabled. `binaryCallbacks: false`
is the legacy JSON callback baseline; the default negotiates binary callbacks.

Each process warms both modes for ten rounds, then measures thirty paired
rounds, alternating JSON-first and binary-first. There are two fresh processes
per runtime, ordered Bun, Node, Node, Bun. No other test or benchmark process
ran alongside these samples. Ratios below are medians of the paired round
ratios, rather than ratios of independent medians. The median helper takes
the upper middle sample for an even count. Times are microseconds per
callback, including the Script work inside that Pump.

Environment: Apple M5, macOS kernel 27.0.0, arm64; Bun 1.4.3 and Node 26.12.0.
The unchanged guest was built with Zig 0.17.0's default safe optimization, from
checkout base `f8644cafc280b91509a438bdf9dfe9a9d275fb9d`. The TS changes are the
#1314 working-tree implementation beside this record. The artifact SHA-256 is
`fb70d30dad2b98414d56ad7f11fd6fd1c9b84568c966328d6fed3caf76066c3f`.

Results, with run 1 / run 2 in each entry:

- **Bun, immediate:** JSON 10.617 / 10.620 µs; binary 11.491 / 11.454 µs;
  paired binary/JSON 1.107× / 1.108×.
- **Bun, properties:** JSON 5.651 / 5.385 µs; binary 6.313 / 6.292 µs;
  paired binary/JSON 1.140× / 1.183×.
- **Node, immediate:** JSON 10.588 / 10.635 µs; binary 9.962 / 10.063 µs;
  paired binary/JSON 0.937× / 0.941×.
- **Node, properties:** JSON 5.654 / 5.707 µs; binary 5.205 / 5.137 µs;
  paired binary/JSON 0.904× / 0.895×.

Binary callbacks reduce these workloads' elapsed time by about 6–11% under
Node and increase it by about 11–18% under Bun on this machine. This is a
runtime-dependent result, not a general speedup claim or a cross-platform gate.
Hosts can select `binaryCallbacks: false` when the JSON layout serves their
workload better. Both modes have identical Fuel and logical allocation for
every recorded Run. These logical counters do not measure JS allocations or GC.
No JS heap allocation reduction is established here.

Raw samples include runtime versions, OS/CPU, artifact identity, paired timings
and accounting:

- [Bun run 1](../../bench/results/ts-wasm-callbacks/2026-10-19-bun-1.json)
- [Bun run 2](../../bench/results/ts-wasm-callbacks/2026-10-19-bun-2.json)
- [Node run 1](../../bench/results/ts-wasm-callbacks/2026-10-19-node-1.json)
- [Node run 2](../../bench/results/ts-wasm-callbacks/2026-10-19-node-2.json)

Reproduce from the repository root:

```sh
(cd impl/zig && zig build -Dtarget=wasm32-wasi --prefix ../../.cache/zig-wasi)
bun bench/ts/src/wasm-callbacks.ts > bun.json
bun build bench/ts/src/wasm-callbacks.ts --target=node --outfile=.cache/ts-callbacks-bench/bench.mjs
NORTHTALK_ROOT="$PWD" node .cache/ts-callbacks-bench/bench.mjs > node.json
```

## Verification

The TS suite and examples passed all 6,259 tests under Bun. The targeted
callback/codec, WASM parity and combined-operation tests pass. The parity and
combined tests exercise both binary and JSON callback modes.

The same callback Host and complete WASM Trace Case runner execute under Bun
and Node, in both callback modes. Each configuration reports 401 passed,
zero failed, zero known divergences, and one case past the existing 64 MiB
frame limit (`limits/persistent-state-minimum`). Every runnable case is checked
both normally and with save/restore between Pumps. The runner prepares TOML
setups under Bun, then bundles the runtime-neutral replay and Host code for
both runtimes; Node does not execute a Bun compatibility shim.

Direct reactor tests check the four needs and result tags on the actual wire,
independent Request/Pump negotiation, Nothing setters, exact decimal scale,
failures, charges and crossing notices. A wrong result ref is refused without
consuming the open need; its corrected JSON answer completes the binary need.
Malformed records and unknown outcomes are rejected before callback dispatch.

Real Chromium passes the 24 shared Value vectors and transferred-buffer worker
checks. A separate worker runs the WASM callback Host in both modes and compares
Values, property setters, effects, Grant release and the complete Trace. This
establishes browser correctness, without a browser performance claim.

Workspace typechecking, targeted ESLint, Markdown link checking and diff
whitespace checks pass. CI's TS/WASM job runs the protocol tests, both runtime
and callback-mode Corpus checks, and the browser worker checks.
