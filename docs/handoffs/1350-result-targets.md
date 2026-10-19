# Result Targets beyond `ask` (#1350)

Specification and implementation acceptance for [#1350](https://github.com/odogono/odgn-talk/issues/1350), extending [ADR 0112](../adr/0112-an-ask-may-name-a-result-target.md) with [ADR 0114](../adr/0114-result-targets-apply-to-result-producing-calls.md). The requested delivery is specification and reference checks first; Core execution and tooling follow.

## Implementation handoff

- **Implemented in:** this specification change: grammar; Name, assignment and failure rules in chapter 4; Command Call, send and Join semantics in chapter 5; lowering, completion charges and retained control in chapter 8; save/restore obligations in chapter 10; diagnostics, ADR and glossary; reference parser and lowering with staged tests.
- **Remaining work:** TS, Go and Zig parser/checker/lowering support for all five forms; Join execution, charging and saved destinations; the deferred Data Files below; Core tests, Conformance Corpus, formatter and LSP acceptance below. Implement `tell`-block Operation lines first as the issue requests. Keep the issue open until implementation and acceptance are complete.
- **Required base:** `main` after this specification change merges, including the original `ask` support from #1351, #1355, #1356 and #1358. The starting checkout is `576853a1`; all four preceding PRs are merged and their original `ask` implementation is present. Relevant sections: [grammar statements](../../spec/02-grammar.md#statements), [Result Targets](../../spec/04-expressions-and-statements.md#result-targets), [calling a Handler](../../spec/05-handlers-messages-and-scheduling.md#calling-a-handler-by-name), [sending](../../spec/05-handlers-messages-and-scheduling.md#sending), [Joins](../../spec/05-handlers-messages-and-scheduling.md#joins), [lowering and costs](../../spec/08-the-abstract-machine-and-the-cost-model.md#result-targets) and [saved state](../../spec/10-save-and-restore.md#saving).
- **Approval still needed:** no new expectation files have been blessed. First approval of new Disassembly, Trace and load-diagnostic expectations remains part of Corpus delivery under the [Corpus guide](../../corpus/README.md#checking).

## Settled behavior

The examples here are staged sources, deliberately outside shared sketches and machine fixtures until the Cores implement them.

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

## Deferred executable Data Files

Do not infer implementation from generated catalogue coverage. These files remain unchanged at the specification stage, following [ADR 0057](../adr/0057-a-send-may-compute-its-message-name.md):

- `spec/data/machine.toml`: add optional trailing `target-kind?`, `target?` operands to `join-ask`, `join-send`, `join-send-named` and `join-send-spread`. Both operands must be present together or absent together. `target-kind` is `local` or `variable`; `target` is the corresponding non-negative index in the calling frame/code unit. Update the operand glossary/schema as needed, and describe registration and whole-Join assignment. Stack effects and the original operands are unchanged.
- `spec/data/costs.toml`: keep the existing Join entry charge and result allocation; add a completion-only Fuel component of 1 per started local target and 3 per started Script Variable target, including repeated destinations. Reserve it after all member answers have converted and been charged, before any target write. No registration allocation/Fuel or additional descriptor logical size. Failed/abandoned Joins pay no target-write component. Express this phase distinction explicitly rather than charging target writes at member start or the first `join-end` suspension.
- Regenerate with `bun run spec:gen`, `bun run syntax:generate`, `bun run go:generate` and `bun run zig:generate`, then run `bun run check`, `bun run go:check` and `bun run zig:check`. Coordinate the catalogue change with all Core consumers; changing the generated instruction descriptors alone does not implement assignment or charging.
- Each Core retains the destination with every member, including already answered members and repeated executions of one source line. Save/import validates destination kind, owning frame/code unit, writable index and member association. Advance the Core's private save-format version when its retained representation changes; do not accept older snapshots while losing destinations. Keep the TS/WASM and Go/Zig adapters and embedded reactor in step with the [Zig task map](../../impl/zig/NAVIGATION.md#after-changing-the-zig-core).

## Acceptance for each Core and tooling

- [ ] `tell`-block lines: immediate and suspending results to new/existing locals, parameters and Script Variables; subsequent arguments can read the target. Fire-and-forget targets fail at the Operation name.
- [ ] Command Calls: local and imported Handlers, labelled calls, defaults/fall-through Nothing, existing suspension checks, and local Handler precedence over a Host Command. Immediate/suspending Host Commands work; fire-and-forget ones fail. Message Path calls with `and wait` retain the actual reply; without it they fail at load without starting a send. Libraries retain their existing restrictions and Grant rechecks.
- [ ] Call statements: named functions, Built-ins, Handlers called function-style, local and foreign Function Values, with/without `and wait` where already legal. A target does not relax `would suspend`, arity, stale-function or no-suspension checks.
- [ ] Waiting sends: receiver-first/last, labelled, computed name and spread variants; invalid target placement is a syntax error, and a valid bare target without waiting is `missing and wait`.
- [ ] Name checks: Constants, captured locals and active collecting targets fail as `put` does; body-wide scope, first-binding slot order and Script Variable resolution match ordinary writes; `it`, `me`, keys and chunks are not target Names.
- [ ] Ordinary failures: argument evaluation, immediate/suspending call errors, bad results, revocation, timeout, Timeout Block abandonment and cancellation do not assign a successful result. Do not promise to undo mutations made by called code. No extra Suspension Point is introduced.
- [ ] Joins: local and Script Variable destinations on all four member instructions, including `tell`-block lines; loops, conditional and zero-reached-member paths, repeated targets across different member sites, reversed reply order, early answers, and ordinary immediate writes in the body. Verify whole-Join success and no member assignments on start/body/member failure, invalid results, timeout, revocation or abandonment. Existing Join restrictions remain enforced.
- [ ] Costs/source maps: ordinary local/variable stores cost 1/3 extra Fuel and use the target Name's position. A member instruction retains its call position; successful completion precharges 1/3 per registered destination at the closing `end`, including duplicates; no target cost on failure, no extra allocation or descriptor logical size. Check exact-budget boundaries and Segment rollback on a completion Limit Fault.
- [ ] Save/restore: pending ordinary call resumes at its result store without repeating the Host effect. Save a pending Join with an early answer and repeated/conditional destinations; settle in a different reply order after restore and verify the same start-order target assignment and `it` list. Failed settlement writes no member targets. Corrupt kind/index/owner/member state is `invalid save`.
- [ ] Corpus: move staged tests from `tools/machine/result-target.test.ts` into `tools/grammar/sketch`, `broken.talk` and `tools/machine/lowering.talk` when all Cores can consume them. Add reviewed Disassembly, Trace, save/restore and load-diagnostic cases; remove/update the former `not in a join` expectation for a member target. Run the affected cases on TS, Go and Zig and update passing gates as required.
- [ ] Formatter and LSP: preserve each target and its order before `and wait`, including comments, labels and Operation lines; expose its write/definition/reference and rename behavior with put scope; diagnostics and completion/hover agree with the settled call mode. Reconcile Core/tooling guides and the issue handoff with actual support.

The reference compiler accepts optional `grants` declarations for mode-sensitive reference tests. It remains a lowering prototype, not a replacement for Core checker, execution, save/restore or Corpus acceptance.
