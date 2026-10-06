# Differential fuzzer

Generates Scripts and Host Input sequences, runs them on the Core, and checks the Traces against conformance oracles. [ADR 0009](../../docs/adr/0009-twin-cores-held-to-bit-for-bit-parity.md) makes fuzzing required practice, outside the normative Spec. [The historical research](../../docs/research/differential-fuzzing.md#historical-proposal) records the original proposal and its superseded assumptions. The [oracle contract](#oracle-contract) below describes this harness ([#138](https://github.com/odogono/odgn-talk/issues/138)).

```sh
bun run fuzz smoke [--seed <n>] [--count <n>] [--output <dir>] [--budget-ms <n>] [--profile <features>] [--go-runner <path>]
bun run fuzz campaign [--seed <n>] [--output <dir>] [--budget-ms <n>] [--search-ms <n>] [--reduction-ms <n>] [--profile <features>] [--go-runner <path>]
bun run fuzz reproduce <case.json> [--go-runner <path>]
bun run fuzz minimize <case.json> [--output <file>] [--budget-ms <n>] [--go-runner <path>]
```

- **`smoke`** runs 64 cases within two minutes and stops at the first finding. CI runs it on every PR with `--seed 1` in [dual-Core mode](#dual-core-mode), so it is a deterministic gate.
- **`campaign`** searches for 20 minutes, then minimizes up to two retained findings, within 30 minutes in all. The [nightly workflow](../../.github/workflows/fuzz.yml) runs one in dual-Core mode from a fresh seed and uploads the findings directory. Start it by hand from the Actions tab with a chosen seed and budget.
- **`--go-runner`** also runs each case on the Go Core and compares the complete Traces ([below](#dual-core-mode)).
- **`reproduce`** reruns a saved case and prints its findings.
- **`minimize`** reduces a saved case while its first finding keeps the same signature, and writes the smaller case.
- **Seeds** are unsigned decimal integers. Case *n* of a run uses seed + *n*, so any case can be regenerated from the summary's seed alone. With no `--seed`, the clock picks one.
- **`--profile`** limits generation to a comma-separated subset of `compute`, `dispatch`, `suspend`, `join`, `decision`, `error`, `scope`, `effect`, `loop`, `send` and `timer`.
- **Exit codes:** 0 for no findings, 1 for findings (or nothing to minimize), 2 for invalid arguments.

## Findings

The output directory, `fuzz-findings/` by default, holds `summary.json`: the seed, commit, case count, finding count and a histogram of Trace record kinds. Each distinct finding signature gets its own directory, written before any reduction starts:

| File | Contents |
| --- | --- |
| `case.json` | The case as generated. Pass it to `reproduce` or `minimize`. |
| `result.json` | Every finding, with the first differing Trace line. |
| `actual.trace` | The Trace the case produced. |
| `peer.trace` | The Go Core's Trace, in dual-Core mode. |
| `minimized.json`, `reduction.json` | The reduced case, and how the reduction went. Only for the first two findings, within budget. |

To work on a nightly finding, download the run's artifact, [build the Go worker](#dual-core-mode), then:

```sh
bun run fuzz reproduce fuzz-findings/<signature>/case.json --go-runner .cache/fuzzworker
bun run fuzz minimize fuzz-findings/<signature>/case.json --output minimized.json --go-runner .cache/fuzzworker
bun run fuzz reproduce minimized.json --go-runner .cache/fuzzworker
```

Leave out `--go-runner` for a finding from the TS oracles alone.

A fixed divergence becomes a corpus case under [`corpus/`](../../corpus/), blessed by the corpus procedure.

## How it works

- **Cases** ([`model.ts`](src/model.ts)) are a setup, Scripts, and abstract Host Inputs with symbolic references, such as "settle the *n*-th pending call". The [runner](src/runner.ts) resolves them against the Core's own state; one with nothing to act on is a no-op. A case also keeps the choices it was generated from, so the minimizer can shrink choices and regenerate.
- **The generator** ([`generator.ts`](src/generator.ts)) builds valid Scripts by construction from the grammar Data File and never calls a Core's checker. Compute Handlers vary inline and margin-stripped fences, multiline and nested holes, escapes, exact tab/space margins and raw fence widths. Their text results are Script Variables observed by Trace and save/restore oracles. Every eighth case is an invalid mutation with one known diagnostic.
- **Oracles** ([`oracles.ts`](src/oracles.ts)) check every case for Trace invariants, generator validity, concrete replay, save and restore at Pump boundaries, one-Segment rollback, Group Fingerprints, metamorphic relations (renaming locals, extra `> vars` reads, display round trips) and limit sweeps. Mutations are checked against their diagnostic.
- **Workers** ([`controller.ts`](src/controller.ts), [`worker.ts`](src/worker.ts)) run cases in a child process with a watchdog, so a hang or crash is a finding rather than a stalled campaign. A crash is rerun in a fresh process before it counts.
- **Minimization** ([`minimize.ts`](src/minimize.ts)) first deletes and shrinks choices, then reduces concrete Host Inputs and Script syntax.

## Dual-Core mode

With `--go-runner <path>`, every case also runs on the Go Core's fuzz worker, and the first differing line of the two complete Traces is a `differential` finding. The TS oracles still run on the TS Core alone. Build the worker from the repository root:

```sh
go -C impl/go build -o "$PWD/.cache/fuzzworker" ./cmd/fuzzworker
bun run fuzz smoke --seed 1 --go-runner .cache/fuzzworker
```

The worker ([`cmd/fuzzworker`](../../impl/go/cmd/fuzzworker/), [`internal/fuzz`](../../impl/go/internal/fuzz/)) speaks the [worker](src/worker.ts) protocol of one JSON request and response per line on stdin and stdout, and does no filesystem or network I/O:

- **`capabilities`** answers with the protocol `version`, the `features` it supports, and the Core's `languageVersion` and `costModel`. The run stops with an error if these versions differ from the TS worker's, or if a case's profile has a feature the worker doesn't list.
- **`run`** replays a case's Host Inputs through the Go corpus runner's replay Host, resolving each symbolic reference against the Go Core's own Trace exactly as [`runner.ts`](src/runner.ts) does. It answers with the `execution` that `evaluate` compares: the Trace, the action and record counts, and Group Fingerprints around each input. A case the harness can't run, such as one with no lifecycle Stub for a Segment, is a `generator` finding; any other failure is a `worker-exception` finding.
- **Anything else** gets `{"error": …}`.

The Go worker runs no oracles, so a divergence it finds in replay, rollback or metamorphic behaviour shows up only as a Trace difference against TS.

## Oracle contract

[Chapter 10](../../spec/10-save-and-restore.md#saving) and [chapter 11](../../spec/11-the-trace-and-conformance.md#save-and-restore-replays) define Save eligibility and replay parity. The shared replay driver attempts Save at eligible boundaries, checks `effects pending` where required, and preserves the original Group on refusal. Successful round trips use the Spec's Trace projection and Host-handle restrictions.

A finite case may end with suspended Runs or open Decisions. The [Trace invariant checker](src/oracles.ts) rejects duplicate Run and Decision terminal outcomes, resetting that accounting at explicit restores; it does not require all work to terminate within the generated input sequence.

Same-input dual-Core comparison uses complete Traces. Metamorphic comparisons have relation-specific projections: local renaming excludes the `identity`, `source`, `pos` and `fingerprint` fields, while save/restore replay excludes its injected records and normalizes save-attempt ids as chapter 11 specifies. Consult [the oracle implementation](src/oracles.ts) before adding a relation; raw Trace equality is not valid for every source or scheduling transformation.
