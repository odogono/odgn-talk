# Recovery Offers tooling and Session evidence (#391)

This slice starts at `173c2870` (PR #401 merged into `feat/recovery-offers`).
Language remains 1.0-rc.2 and provisional Cost Model 0. The shared tooling stack
uses the existing syntax and execution support. No Data File or Corpus
expectation changes are made; first-blessing review remains in #392.

Current support is described in the [TS](../../../impl/ts/README.md#tooling-debug-hooks),
[Go](../../../impl/go/README.md), [tooling](../../../tooling/stack/README.md)
and [Playground](../../../tooling/playground/README.md#what-it-does) guides.
The debugger is a TS-only tooling surface; both Cores replay the same execution
Traces. Chapter 9's Inspect schema stays unchanged.

## Debugger and replay

[Runtime-independent checks](../../../tooling/stack/tests/verify-recovery-debug.ts)
run in Bun, Node and the browser. Step over a failed Library call and step out
of its failing helper both reach the caller's active recovery policy. Policy
stepping reaches each statement, enters helpers and returns at the active caller
depth. Retained failed callees do not add to that depth.

Paused frame views include retained continuations, dispatch/cleanup cursors and
helpers. The cursor's owning-frame index resolves to the ultimate real frame;
both show the same locals, including policy writes. Ordinary frame views omit
the new fields. All paused collections are detached; debugger state remains
outside saves, Trace and charges.

[Nested checks](../../../tooling/stack/tests/recovery-debug.test.ts) pause every
instruction through nested policy and cleanup, compare shared locals and the
active position, then compare the complete unpaused Trace. Replay pauses at
source breakpoints, reverses through execution and reproduces that Trace.
The helper case pins chosen/entered attempt order `1, 1, 2, 2`; the aborted
and choice-cleanup cases pin one choice with no entry.
Both Cores' existing recovery acceptance gates explicitly execute all seven
Recovery Offer Corpus cases with ordinary and injected save/restore replay.

## Sessions, CLI and Playground

[TS Session tests](../../../impl/ts/tests/session.test.ts),
[Go driver tests](../../../impl/go/driver/repl_test.go) and
[CLI tests](../../../tooling/cli/tests/cli.test.ts) load the existing rows Library,
then choose `useValue(0)` from a Session Script over `["5", "bad", "7"]`.
They assert `[5, 0, 7]`, preserving accumulated Library work, and replay the
recorded Transcript. The native suites also compare the complete replayed Trace
and choice/entry pairing.

[Playground tests](../../../tooling/playground/tests/session.test.ts) save a
Library tab, apply a Script tab, pause and step through caller policy, and
display the Library action with its preserved accumulator and bound argument.
They verify the reversed panel's owning-frame index, shared locals and tab
position, then replay the Transcript and compare the complete Trace. Live and
replay panels use the same frame projection.

Required validation: affected tooling and Core suites, Node tooling/CLI checks,
browser debugger smoke, `bun run check`, typecheck, lint/format, Go race tests,
vet, and both explicitly named recovery Corpus runners. Results are recorded
in the PR.
