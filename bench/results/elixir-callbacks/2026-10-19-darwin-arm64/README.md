# Elixir callback fields, 2026-10-19 (#1315)

The Elixir Host exchanges callbacks in the fields envelope, but these local
measurements do **not** establish an immediate-call speedup. Immediate calls
regress; the small property-refusal improvement is not robust across scheduler
settings. The JSON compatibility option remains available. No performance gate
was specified in #1315, and the Go adapter's gains from #1311 do not carry over
to the current Elixir codec/owner implementation.

## Environment and method

- Apple M5, macOS 27.0.1 (26A434), arm64.
- Erlang/OTP 29, ERTS 17.1.1, Elixir/Mix 1.20.4, Wasmex 0.15.1.
- Repository base: `f8644cafc280b91509a438bdf9dfe9a9d275fb9d` (#1311),
  plus #1315's Elixir changes in this directory's accompanying revision.
- Zig 0.17.0, `zig build -Dtarget=wasm32-wasi --prefix ../../.cache/zig-wasi`.
  Published release: [reactor-v0.8.0](https://github.com/odogono/odgn-talk/releases/tag/reactor-v0.8.0),
  built from the base above. Local and downloaded release SHA-256 both:
  `fb70d30dad2b98414d56ad7f11fd6fd1c9b84568c966328d6fed3caf76066c3f`.
- Same reactor and Host code in both modes: `binary_callbacks: false` is the
  before/JSON path, `true` is after/fields. Ordinary `request/5` and automatic
  Pump remain JSON, isolating callback encoding. Setup is outside timing.
- Eight interleaved A/B rounds, alternating which mode goes first. Each mode
  starts a fresh owner, warms ten Requests, then measures forty Requests of
  100 crossings. Every Request's result is checked. Units below are complete
  Request wall time divided by 100, including owner, callback Tasks, Script
  execution, Reports and transport; they are not isolated callback CPU time.
- Default BEAM schedulers: 10 online. A second run uses `+S 2:2`. These are
  local workstation observations, with substantial variation between rounds,
  not an isolated-machine or cross-platform gate.

## Results

Each figure is the median of the eight per-round medians. Lower is better.

| Workload | JSON, µs/crossing | Fields, µs/crossing | Fields vs JSON |
| --- | ---: | ---: | ---: |
| Immediate echo of an integer, default schedulers | 82.33 | 100.60 | 22.2% slower |
| Property getter refusal, default schedulers | 79.43 | 74.47 | 6.2% faster |
| Immediate echo, two schedulers | 77.46 | 90.30 | 16.6% slower |
| Property getter refusal, two schedulers | 81.01 | 80.60 | 0.5% faster |

The median of the eight paired percentage changes is respectively +15.8%,
−8.5%, +14.2% and −0.4%. This also shows the immediate-call regression and
weak property result rather than a broad performance win.

The Elixir public API does not yet register Object Kinds or implement property
callbacks. The property workload registers a real guest Object through a small
setup-only transport wrapper, then uses the unchanged owner's `no Host Objects`
refusal. The Script catches each host error and checks that all 100 were caught.
It exercises real prop needs/results, but does **not** measure successful public
Host Object property access. The wrapper delegates measured frames directly to
the WASI transport.

## Reproduction and raw samples

From `impl/elixir/`, after rebuilding the reactor and fetching dependencies:

```sh
MIX_ENV=test mix run ../../bench/results/elixir-callbacks/2026-10-19-darwin-arm64/measure.exs
ERL_FLAGS='+S 2:2' MIX_ENV=test mix run ../../bench/results/elixir-callbacks/2026-10-19-darwin-arm64/measure.exs
```

[measure.exs](measure.exs) contains the Script, Capability, property fixture,
assertions and timing loop. [samples.jsonl](samples.jsonl) and
[samples-s2.jsonl](samples-s2.jsonl) retain all 2,560 Request samples, each
normalised to nanoseconds per crossing. The comparison changes callback mode,
not the reactor version; it does not attribute earlier guest changes to #1315.

## Verification

- `mix test`: 102 tests pass with binary callbacks by default (the default was later switched to JSON pending #1316).
- `NORTH_TALK_CALLBACKS=json mix test`: the same 102 tests pass with JSON by
  default. Explicit interoperability cases exercise both modes in either run.
- `mix format --check-formatted` and `MIX_ENV=test mix compile --warnings-as-errors` pass.
- The shop consumer fetches and verifies the published reactor, and all five
  of its tests pass.
- `CGO_ENABLED=0 go run -tags talk_zig_experimental ./cmd/corpus --check-passing`
  and the same command with `TALK_ZIG_CALLBACKS=''`: 446 cases pass in each.
  This is the existing Go/Zig Corpus runner, **not** an Elixir Host Corpus
  runner (there is none). Elixir interoperability is covered by its real
  reactor tests, including property get/set refusal, lifecycle crossings,
  Nothing, Function Values, malformed needs and combined exchanges.
- The tag push's repository pre-push checks passed: lint, TS formatting and
  `bun run check` (including Spec, grammar, machine, Corpus schema, generated
  tables, Unicode, docs and save-format checks). Those ran before the final
  docs/pin changes; docs and save-format checks were repeated afterwards.
