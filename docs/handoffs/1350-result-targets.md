# Result Targets beyond `ask` (#1350)

Specification and implementation acceptance for [#1350](https://github.com/odogono/odgn-talk/issues/1350), extending [ADR 0112](../adr/0112-an-ask-may-name-a-result-target.md) with [ADR 0114](../adr/0114-result-targets-apply-to-result-producing-calls.md). The specification landed in #1361; this delivery implements Core execution and tooling.

## Implementation handoff

- **Implemented in:** specification PR [#1361](https://github.com/odogono/odgn-talk/pull/1361), merged as `8033d89b`; the Core delivery adds TS, Go and Zig parsing/checking/lowering for all five forms, Join completion and persistence, executable Data Files and generated catalogues, shared sketches, Corpus cases, formatter and LSP regression coverage. The Go captured-local correction is tracked in [#1365](https://github.com/odogono/odgn-talk/issues/1365), and the Zig restore-probing correction in [#1369](https://github.com/odogono/odgn-talk/issues/1369).
- **Remaining work:** none. #1370 merged and the expectations below are blessed.
- **Required base:** `main` containing #1361 (`8033d89b`); Core work starts from `e4275bb0`. Relevant sections: [grammar statements](../../spec/02-grammar.md#statements), [Result Targets](../../spec/04-expressions-and-statements.md#result-targets), [calling a Handler](../../spec/05-handlers-messages-and-scheduling.md#calling-a-handler-by-name), [sending](../../spec/05-handlers-messages-and-scheduling.md#sending), [Joins](../../spec/05-handlers-messages-and-scheduling.md#joins), [lowering and costs](../../spec/08-the-abstract-machine-and-the-cost-model.md#result-targets), and [saved state](../../spec/10-save-and-restore.md#saving).
- **Approval still needed:** none. The maintainer approved the first blessing of [the Disassembly](../../corpus/disassembly/result-targets/s.dis), [load diagnostics](../../corpus/capabilities/result-targets-load-checks/case.trace), and the [ordinary calls](../../corpus/result-targets/ordinary/case.trace), [Join](../../corpus/result-targets/join/case.trace), [completion Fuel](../../corpus/result-targets/completion-fuel/case.trace) and [failure](../../corpus/result-targets/failures/case.trace) Traces on 2026-10-20 ([record](../reviews/result-targets-blessings/README.md)).

## Settled behavior

These forms now execute in all three Cores. The shared sketch is [result-targets.talk](../../tools/grammar/sketch/result-targets.talk); the reference regression tests remain in [result-target.test.ts](../../tools/machine/result-target.test.ts).

```text
tell storage
  size "page" into bytes
  load "page" into saved and wait
end tell
lookup "page" into found
fetch "page" into saved and wait
f(3) into answer
f(3) into answer and wait
send load with "page" to worker into saved and wait
send to worker: move piece to square into moved and wait
```

Every target is a bare Name with put semantics; `it` is still set and `and wait` is last. Result Targets neither change resolution nor add implicit suspension. A fire-and-forget block line/Host Command, including `say`, is `wrong mode` at its Operation/command name. An explicit `send`, or a Command Call resolved to the Message Path, with a target and no `and wait` is `missing and wait` at `send`/the command name. One-line `tell … to` retains its old grammar. Local/imported Handlers, named functions, Function Values and Host Commands retain their existing suspension checks. Waiting Command Calls and call statements remain excluded from Join and Timeout Block bodies under their existing rules.

```text
wait for all
  ask storage to load "a" into first and wait
  repeat 3 times
    send next to worker into last and wait
  end repeat
end wait
```

Each started member registers its destination; no member target is written during the body or on an early answer. Whole-Join success assigns targets in member start order after converting and charging all answers and reserving all target charges. A skipped member leaves its target unchanged, and a repeated destination ends with the last-started member's answer. `it` remains the whole answers list. A failed start, body error, failed member, failed result conversion/charging, timeout or abandonment writes none of the member targets. Ordinary immediate writes in the body are unaffected by that guarantee.

## Executable Data Files and persistence

`machine.toml` declares paired optional trailing `target-kind?`, `target?` operands on `join-ask`, `join-send`, `join-send-named` and `join-send-spread`. Stack effects and existing operands are unchanged. `costs.toml` makes the Join's `steps` component completion-only: 1 Fuel per started local destination and 3 per started Script Variable destination, including duplicates. There is no registration charge, extra allocation or descriptor logical size. Cores convert and charge every answer, then reserve the list allocation and all target charges before writing any destination.

Each member retains its checked instruction and owning frame. The instruction's immutable destination operands supply the kind and writable index; repeated executions retain separate member records. Restore validates the owner and member instruction within the active Join's body, as well as destination bounds. Private formats advance to TS 11, Go `go/10` and Zig `zig/14`; older layouts are refused rather than silently dropping destinations. The Go embedded reactor and TS/WASM checks follow the [Zig task map](../../impl/zig/NAVIGATION.md#after-changing-the-zig-core). The Elixir pin uses [reactor-v0.10.0](https://github.com/odogono/odgn-talk/releases/tag/reactor-v0.10.0), published from `5aa3675a`. Its downloaded WASM and published checksum match the pinned SHA-256 `4696a7e225317f91c46eba82248da5dbe905c6f86508c9970ed9bbc0a479f14c`; all five shop example tests pass after fetching the release without a reactor override.

## Acceptance for each Core and tooling

- [x] `tell`-block lines: immediate and suspending results to new/existing locals, parameters and Script Variables; subsequent arguments can read the target. Fire-and-forget targets fail at the Operation name.
- [x] Command Calls: local and imported Handlers, labelled calls, defaults/fall-through Nothing, existing suspension checks, and local Handler precedence over a Host Command. Immediate/suspending Host Commands work; fire-and-forget ones fail. Message Path calls with `and wait` retain the actual reply; without it they fail at load without starting a send. Libraries retain their existing restrictions and Grant rechecks.
- [x] Call statements: named functions, Built-ins, Handlers called function-style, local and foreign Function Values, with/without `and wait` where already legal. A target does not relax `would suspend`, arity, stale-function or no-suspension checks.
- [x] Waiting sends: receiver-first/last, labelled, computed name and spread variants; invalid target placement is a syntax error, and a valid bare target without waiting is `missing and wait`.
- [x] Name checks: Constants, captured locals and active collecting targets fail as `put` does; body-wide scope, first-binding slot order and Script Variable resolution match ordinary writes; `it`, `me`, keys and chunks are not target Names.
- [x] Ordinary failures: argument evaluation, immediate/suspending call errors, bad results, revocation, timeout, Timeout Block abandonment and cancellation do not assign a successful result. Do not promise to undo mutations made by called code. No extra Suspension Point is introduced.
- [x] Joins: local and Script Variable destinations on all four member instructions, including `tell`-block lines; loops, conditional and zero-reached-member paths, repeated targets across different member sites, reversed reply order, early answers, and ordinary immediate writes in the body. Verify whole-Join success and no member assignments on start/body/member failure, invalid results, timeout, revocation or abandonment. Existing Join restrictions remain enforced.
- [x] Costs/source maps: ordinary local/variable stores cost 1/3 extra Fuel and use the target Name's position. A member instruction retains its call position; successful completion precharges 1/3 per registered destination at the closing `end`, including duplicates; no target cost on failure, no extra allocation or descriptor logical size. Check exact-budget boundaries and Segment rollback on a completion Limit Fault.
- [x] Save/restore: pending ordinary call resumes at its result store without repeating the Host effect. Save a pending Join with an early answer and repeated/conditional destinations; settle in a different reply order after restore and verify the same start-order target assignment and `it` list. Failed settlement writes no member targets. Corrupt kind/index/owner/member state is `invalid save`.
- [x] Corpus: shared coverage moves the staged sources from `tools/machine/result-target.test.ts` into `tools/grammar/sketch`, `broken.talk` and `tools/machine/lowering.talk` when all Cores can consume them. Add Disassembly, Trace, save/restore and load-diagnostic cases with first review pending; remove/update the former `not in a join` expectation for a member target. Run the affected cases on TS, Go and Zig and update passing gates as required.
- [x] Formatter and LSP: preserve each target and its order before `and wait`, including comments, labels and Operation lines; expose its write/definition/reference and rename behavior with put scope; diagnostics and completion/hover agree with the settled call mode. Reconcile Core/tooling guides and the issue handoff with actual support.

The reference compiler accepts optional `grants` declarations for mode-sensitive reference tests. It remains a lowering prototype, not a replacement for Core checker, execution, save/restore or Corpus acceptance.
