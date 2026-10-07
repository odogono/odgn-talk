# Recovery Offers final integration and expectation review (#392)

Approval status: **pending human first-blessing review**. No expectation in this
package has been approved by this record. Cross-Core execution agreement is a
separate requirement. Language stays **1.0-rc.2**, provisional Cost Model **0**.
Unrelated pending blessings remain untouched.

## Exact approval scope

The [manifest](expectations.tsv) lists **50 expectation files** with provenance
and SHA-256 hashes: seven new `case.trace` files and one new `recovery.dis`,
41 existing expectation corrections from slice 2, and one additional Store
correction exposed by merging current `main`. The [complete diff](expectation-diffs.patch)
contains all 50 candidates. [Per-Run Fuel and retained-state figures](figures.md)
list the before/after records for every existing correction.

Slice-2 diffs compare `cdee6bf` with the frozen candidates at `52ac482` (PR #405).
New candidates are shown from empty files at that same integration revision.
The Store correction compares `origin/main` at `c73d919` with the final candidate.
Later approvals of unrelated headers on `main` are not part of this review;
comparison ignores comments and blank lines. No `--bless` command generated this
package. Changing any execution record after approval requires another review.

After approval, remove only the seven Recovery Offers Trace `Unblessed` markers
and the marker in `corpus/disassembly/recovery-offers/case.toml`. That metadata
file is included in the approval scope; it is not an additional expected output.
Existing cases that await approval for unrelated work retain their markers.
The eight Recovery Offers cases are already in the Go passing gate. The
[acceptance test](../../../impl/go/internal/corpus/execution_test.go) now checks
each required entry, including Disassembly, so removing one cannot silently
shrink the gate; approval does not re-add duplicate entries.

### Human review links

- Original contract: [PR #386](https://github.com/odogono/odgn-talk/pull/386).
- Slice-2 candidates and original discussion: [PR #396](https://github.com/odogono/odgn-talk/pull/396),
  [review record](../recovery-offers-runtime/README.md).
- Nested/cancellation/action candidates: [PR #400](https://github.com/odogono/odgn-talk/pull/400),
  [review record](../recovery-offers-nested/README.md).
- Dispatch boundary validation: [PR #401](https://github.com/odogono/odgn-talk/pull/401),
  [evidence](../recovery-offers-saves/README.md).
- Debugger/session/Playground evidence: [PR #405](https://github.com/odogono/odgn-talk/pull/405),
  [evidence](../recovery-offers-tooling/README.md).
- Final first-blessing decision: [issue #392](https://github.com/odogono/odgn-talk/issues/392).
  **Pending; implementation PR reviews do not supply this approval.** The final
  slice PR links this package for that decision. Record the maintainer's explicit
  response and reviewed commit here before removing markers.

## Independent Fuel and state derivation

These arithmetic checks follow [chapter 8](../../../spec/08-the-abstract-machine-and-the-cost-model.md)
and [`costs.toml`](../../../spec/data/costs.toml), independent of either Core's
reported Fuel/state. Reference lowering supplies the instruction path, not the
charged result. Each divided term rounds up separately.

### Exact choice boundary

For [`recovery-offers/costs`](../../../corpus/recovery-offers/costs/s.talk),
`go` has five local slots (`it`, `value`, `e`, and two catch temporaries):

- Before `choose-offer`: Handler dispatch 4 + `const "bad"` 1 + `throw` 10 +
  `store`/`load`/`store`/`move` 4 + `const 7` 1 = **20 Fuel**.
  Search leaves no real frame, so adds no unwind. `throw` allocates **48 bytes**.
- Choice: `8 + count` = 9 plus one owner lookup `4 * 1` = 4 = **13 Fuel**.
  Total **33**. It creates no allocated Script Value and emits attempt 1 followed
  by entry. Fuel limit 32 cannot pay lookup after spending 29, so emits neither;
  limit 33 admits entry but faults before the first action instruction.
- Action: `load value` 1 + `return` 2 = **3 Fuel**; completed total **36**.
- A 5-Fuel slice admits the indivisible 13-Fuel choice, incurs **8 debt**, then
  consumes the next slice without execution and starts the following one with
  3 debt. The remaining 2 credits admit `load` and `return`, yielding the
  candidate's **13 / 0 / 3** subsequent Pump Fuel figures.

Logical Error size for code unit `s` is **289**:
`{code: "bad", at: {unit: "s", handler: "go", line: 3, column: 5}}` has a
32-byte two-entry map, 39 bytes for its code key/value, and 218 for the at
key/value. The at map is `48 + 37 + 41 + 36 + 38 = 200`; its key is 18.

Before choice, owner base `64 + 5*8 = 104`, locals `2*8 + 3*289 = 883`,
Run base 96, context `96 + 289 = 385`, activation `48 + 16 = 64`:
**104 + 883 + 96 + 385 + 64 = 1532 bytes**. After action entry, contexts and
activation are freed; the parameter grows from Nothing (8) to number (16):
**104 + 891 + 96 = 1091 bytes**. Ending the Run drops retained state to **0**.
Owner locals are counted once despite sharing; each separate Error holding
counts again under the no-sharing size rule.

### Nested escape and cancellation boundaries

For the shared [same-owner policy escape](../../../tools/machine/recovery-nested-cases.json),
each text catch head lowers to one Error `store`, four slot operations and three
pattern tests. Each slot/test costs 1, so a head costs **8 Fuel**, including
`test-constant` at the fixed `test` rate. Two throws each cost `const 1 + throw
10 = 11`. Dispatch 4 + throws 22 + heads 16 + `catch-accept` 1 + result
`const 1 / return 2` = **46 Fuel**. Selection control is not a real frame and adds
no synthetic unwind. Introducing `fail()` adds call 8 and one real-frame search
leave 4, giving **58 Fuel**; the retained helper must not be charged twice.

For [cancelled policy cleanup](../../../impl/ts/tests/recovery-cancellation-state.test.ts),
`kept = [1, 2, 3]` is `16 + 3*8 + 3*16 = 88` bytes. In unit `test`, Error size
is 292, so owner Values total `8 + 88 + 3*292 = 972`. The real owner must remain
although it has no finally: Run 96 + activation 48 + owner base 64 + slots 40 +
Values 972 = **1220 bytes**. Cancellation pays no unwind and keeps the owner
for the policy-local finally that reads `kept`.

### Existing correction rules

An ordinary accepting catch adds **1 Fuel** from `catch-accept`; failed catch
search replaces `load` plus old `rethrow` with **1-Fuel `catch-next`**. Search
charges **4 per real frame left** before testing; popping later is free.
Changes to temporary allocation, PCs and slice cutoffs can move costs between
Stretches without changing their sum. Catch Guards now precede deeper cleanup,
so their records move accordingly. At a preemption boundary a dispatch context
adds `96 + contents(Error)` and an activation `48 + contents(stack)`, while any
new slots add `8 + size(Value)` to a real owner. The explicit boundary totals
above and the [exact per-case figures](figures.md) make these changes reviewable.

`capabilities/standard-store-errors` Run 7 accepts one same-frame ordinary catch:
**57 + catch-accept 1 = 58 Fuel**, with the existing **79 allocation** and
**0 retained state** unchanged. Its Segment, Run and Pump each change 57 → 58;
no other Store record changes. The Library offer forms and retained locals add
no normal-path offer-registration Fuel.

## Acceptance mapping

All implementation criteria in parent #383 have merged evidence. First-blessing
approval and the final integration merge remain separate delivery steps.

| Parent criterion | Merged evidence |
| --- | --- |
| Both row policies retain accumulation | #396, #401 (Library/callback snapshots), #405 (sessions) |
| Rejecting catches transparent; catch-all barrier; pre-cleanup tests | #396, #400 |
| Grammar, arity forms, binding/exit/suspension checks, formatting | #394 |
| Library nesting, recursion/shadowing, dynamic lookup and Run boundaries | #396, #400 |
| Decline/Guard order, shared owner writes, nested isolation | #396, #400 |
| Cleanup and cancellation enumerate scopes exactly once | #400, #401 |
| Exact atomic Fuel/debt, state sizes, allocation and canonical metadata | #396, #400 |
| Existing ordinary catch expectations re-derived | #396; exact corrections consolidated here |
| All dispatch save/restore boundaries and malformed snapshot refusal | #401; current-main buffer compatibility fixed in #392 |
| Limit Fault/Stop/effects and legal action suspension | #400, #401 |
| Attempt pairing, invalid choices, nested ordering, no-entry and debug/replay | #396, #400, #401, #405 |

## Current-main compatibility

The final slice merges `main` at `c73d919`, retaining Store support and Go
allocation improvements. Generated conflicts are resolved by the generators.
Go's reusable active operand buffer could also be referenced by a retained
activation; overwriting it changed saved control in ordinary versus restored
execution at step 62 of the row-policy test. Recovery now detaches that buffer
while preserving actual shared owner locals. Ordinary control keeps its reuse. The throw path also detaches consumed operands
before raising; otherwise selection overwrites a retained counted-loop iterator.
The shared `throw retains counted-loop iterator during dispatch` case returns 2
on both Cores and joins every-boundary save/restore testing.
The original failing snapshot suite passes with this correction, including all
40 scenarios at Slice 1 and at Slice 7 / cap 3, Library callbacks and cancellation.

## Validation

- Spec checks, generated Go checks and all documentation fences: pass.
- Full workspace tests, typecheck, lint and formatting: pass.
- Go race/vet, full corpus gates, Node tooling/CLI and builds: pass.
- Seed-1 dual-Core fuzz: 64 cases, zero findings.
- All 50 approval cases are checked explicitly on TS, and the complete 307-case
  Go gate passes, including ordinary and transparent Save/Restore replay.
- All eight Recovery Offers cases are explicitly checked while unblessed on
  both Cores, including ordinary and transparent Save/Restore replay. Their
  eventual default/gate status cannot silently substitute for explicit approval.
