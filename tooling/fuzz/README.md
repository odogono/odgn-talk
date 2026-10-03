# Differential fuzzer

Generates Scripts and Host Input sequences, runs them on the Core, and checks the Traces against conformance oracles. [ADR 0009](../../docs/adr/0009-twin-cores-held-to-bit-for-bit-parity.md) makes fuzzing required practice, outside the normative Spec. [The research](../../docs/research/differential-fuzzing.md) gives the design; this harness is the TS-only first step of it ([#138](https://github.com/odogono/odgn-talk/issues/138)).

```sh
bun run fuzz smoke [--seed <n>] [--count <n>] [--output <dir>] [--budget-ms <n>] [--profile <features>]
bun run fuzz campaign [--seed <n>] [--output <dir>] [--budget-ms <n>] [--search-ms <n>] [--reduction-ms <n>] [--profile <features>]
bun run fuzz reproduce <case.json>
bun run fuzz minimize <case.json> [--output <file>] [--budget-ms <n>]
```

- **`smoke`** runs 64 cases within two minutes and stops at the first finding. CI runs it on every PR with `--seed 1`, so it is a deterministic gate.
- **`campaign`** searches for 20 minutes, then minimizes up to two retained findings, within 30 minutes in all. The [nightly workflow](../../.github/workflows/fuzz.yml) runs one from a fresh seed and uploads the findings directory. Start it by hand from the Actions tab with a chosen seed and budget.
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
| `minimized.json`, `reduction.json` | The reduced case, and how the reduction went. Only for the first two findings, within budget. |

To work on a nightly finding, download the run's artifact, then:

```sh
bun run fuzz reproduce fuzz-findings/<signature>/case.json
bun run fuzz minimize fuzz-findings/<signature>/case.json --output minimized.json
bun run fuzz reproduce minimized.json
```

A fixed divergence becomes a corpus case under [`corpus/`](../../corpus/), blessed by the corpus procedure.

## How it works

- **Cases** ([`model.ts`](src/model.ts)) are a setup, Scripts, and abstract Host Inputs with symbolic references, such as "settle the *n*-th pending call". The [runner](src/runner.ts) resolves them against the Core's own state; one with nothing to act on is a no-op. A case also keeps the choices it was generated from, so the minimizer can shrink choices and regenerate.
- **The generator** ([`generator.ts`](src/generator.ts)) builds valid Scripts by construction from the grammar Data File and never calls a Core's checker. Every eighth case is an invalid mutation with one known diagnostic.
- **Oracles** ([`oracles.ts`](src/oracles.ts)) check every case for Trace invariants, generator validity, concrete replay, save and restore at Pump boundaries, one-Segment rollback, Group Fingerprints, metamorphic relations (renaming locals, extra `> vars` reads, display round trips) and limit sweeps. Mutations are checked against their diagnostic.
- **Workers** ([`controller.ts`](src/controller.ts), [`worker.ts`](src/worker.ts)) run cases in a child process with a watchdog, so a hang or crash is a finding rather than a stalled campaign. A crash is rerun in a fresh process before it counts.
- **Minimization** ([`minimize.ts`](src/minimize.ts)) first deletes and shrinks choices, then reduces concrete Host Inputs and Script syntax.

The dual-Core mode compares complete Traces from a second runner, passed in with `--go-runner <path>`. It speaks the [worker](src/worker.ts) protocol of one JSON request and response per line, and stays unused until the Go Core has a fuzz runner.
