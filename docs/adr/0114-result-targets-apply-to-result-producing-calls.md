# Result Targets apply to result-producing calls

Extend [ADR 0112](0112-an-ask-may-name-a-result-target.md)'s `into name` to `tell`-block Operation lines, Command Calls (including Host Commands), call statements and waiting sends, and allow a target on each Join Member ([#1350](https://github.com/odogono/odgn-talk/issues/1350)). These forms already leave an answer in `it`, so retaining it should have the same spelling and put semantics. The target is a bare Name, `and wait` stays last, and a target adds no suspension or change to resolution. This narrows the initial Join exclusion in ADR 0112 and extends [ADR 0063](0063-a-tell-block-calls-several-operations-of-one-grant.md), [ADR 0094](0094-host-commands-are-command-call-spellings-of-granted-operations.md) and [ADR 0026](0026-a-join-starts-several-calls-from-one-run-and-suspends-once.md).

A fire-and-forget Operation has no answer: a target on its block line or Host Command is `wrong mode`, including `say`. A Command Call that resolves to the Message Path, or an explicit `send`, may have a target only with explicit `and wait`; otherwise it is `missing and wait`. Silently waiting would hide a Segment boundary, while assigning Nothing would pretend that the sent message had answered. Local/imported Handler calls, immediate and suspending Host Commands, named functions and Function Values retain their existing mode and suspension checks. One-line `tell … to` remains fire-and-forget and has no target syntax.

A Join Member registers its destination at start. Only whole-Join success writes member targets, in member start order, after all answer conversion and charging. Thus conditional members write only when reached, repeated targets get the last-started member's answer, and an early answer is never mistaken for whole-Join success. `it` remains the full list. A start failure, body error, member failure, timeout or abandonment writes none of these targets. Immediate calls in the body keep their ordinary assignment timing. These are result assignments; they do not roll back writes that called code or the Join body itself already made.

## Considered Options

- **Assign each target as its answer arrives.** This changes Script Variables while their Run waits, makes the winner of repeated targets depend on reply order and leaves partial assignments on failure.
- **Emit target stores after `join-end` using source member indexes.** Loops and skipped branches make start positions dynamic; recording each reached destination beside its member is simpler and survives saves directly.
- **Collect a list for a repeated target.** This introduces a second assignment meaning for `into`; the Join's existing answer list already keeps every answer.
- **Permit targets on fire-and-forget calls and assign Nothing.** This conceals a missing reply rather than retaining a result.

## Consequences

- Ordinary calls keep ADR 0112's `store 0` followed by `move 0 x`, or `load 0` and `store-var x`. No new Suspension Point or Script Error separates these writes.
- The four `join-*` member instructions gain an optional pair of destination operands, `target-kind` (`local` or `variable`) and `target` (its index). Both are absent or both present. `join-end` precharges all target writes and commits them in start order before pushing the complete answers list; the following `store 0` retains the existing `it` rule. The precise lowering, costs and retained-state rules are in [chapter 8](../../spec/08-the-abstract-machine-and-the-cost-model.md#result-targets).
- Saves retain and validate the member destinations; each Core that changes its private format advances its format version. Restore never repeats an effect just to recover a target.
- Beginner Surface, with no new Lint or Advanced tag. The formatter keeps the target before `and wait`; checker and LSP treat its Name as a write with the same scope as `put`.
- Delivery follows [ADR 0057](0057-a-send-may-compute-its-message-name.md): grammar, prose and reference checks first. Optional machine operands and the Join rate change land with Core support, and staged cases move into shared fixtures afterwards. The [implementation handoff](../handoffs/1350-result-targets.md) records that boundary and acceptance.
