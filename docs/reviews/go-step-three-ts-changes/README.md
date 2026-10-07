# TS Core changes made during Go step 3 (#325)

Review package for [#325](https://github.com/odogono/odgn-talk/issues/325),
prepared on 2026-10-07 against `main` at `12a35fb`. While implementing Go Core
step 3 ([#134](https://github.com/odogono/odgn-talk/issues/134)), paired
execution showed six places where TS diverged from the Spec. Each Go PR fixed
the TS runtime itself instead of under a TS issue. TS step 3
([#128](https://github.com/odogono/odgn-talk/issues/128)) had already been
reconciled, so these changes are listed here for review from the TS side.

The Trace expectations each change relies on are already approved. They are
blessed on both Cores and carry no `Unblessed` marker; their approval is in the
[step-3](../step-three-blessings/README.md),
[Go step-4](../go-step-four-blessings/README.md) and
[event-test charging](../event-test-charging/README.md) records. This package
asks a separate question: **does each TS code change implement the Spec rule it
cites?** Approving the Traces does not answer that.

Code links point to current `main`. The diffs are the `impl/ts/src` part of each
merged PR (`gh pr diff <n>`).

## #271: replacement waits for the dispatch charge

[PR #271](https://github.com/odogono/odgn-talk/pull/271), merged as `f46302c`.

**Before:** a `, replacing` clause cancelled the earlier Runs of its clause as
soon as it was selected, before it paid for dispatch. A replacing Run with
4 Fuel faulted at its first instruction, but its owner had already been
cancelled.

**After:** cancellation waits until the entry charge (`clause` + first
instruction) succeeds. `Run.step` takes a one-step callback, held in
`clauseChargeCallbacks` outside saved state, and `payAmount` invokes it only
after an entry charge succeeds. With 4 Fuel (`clause` + `const` = 5) the Run
faults and the owner keeps running; with 5 Fuel the owner is cancelled, and a
later fault doesn't undo that. See `replaceEarlier` in
[`group.ts`](../../../impl/ts/src/group.ts) and `clauseChargePending` in
[`machine.ts`](../../../impl/ts/src/machine.ts).

**Spec basis:**

- [Ch. 8, Charging](../../../spec/08-the-abstract-machine-and-the-cost-model.md#charging):
  "Dispatch charges the `clause` rate for each Handler Clause it tries, at the
  clause body's first instruction, added to that instruction's own charge. So a
  Run that can't pay for a clause faults at that instruction, with its position,
  and the clause is never tried."
- [Ch. 5, Queueing Policies](../../../spec/05-handlers-messages-and-scheduling.md#queueing-policies):
  "**`, replacing`:** every earlier Run of the clause that hasn't ended is
  cancelled …, and then the new Run goes on."

The clause is never tried if its charge fails, so replacement can't happen yet.

**Evidence:** `cancellation/policy-dispatch-limits`,
`cancellation/policy-clause-selection`; TS tests "replacement waits for the
combined dispatch charge" (`group.test.ts`) and "a replacement paused before
payment cancels its owner only after paying" (`debug.test.ts`).

- [ ] Confirmed against the Spec
- [ ] Disagree:

## #272: an ordinary Decision is allowed only after the complete first charge

[PR #272](https://github.com/odogono/odgn-talk/pull/272), merged as `a0930ca`.

**Before:** a clause without `, deciding` sealed its Decision as allowed when
selected, before paying for dispatch. With 4 Fuel the Decision was allowed and
the Run then faulted.

**After:** the seal moves into the same paid-dispatch callback (`dispatchPaid`
in [`group.ts`](../../../impl/ts/src/group.ts)). With 4 Fuel the Run faults at
its first instruction and the Decision is `Undecided`, with no Fuel spent. With
5 Fuel it is allowed, and a later body fault doesn't change that.

**Spec basis:**

- [Ch. 5, Decisions](../../../spec/05-handlers-messages-and-scheduling.md#decisions):
  "Clauses without `, deciding` allow the Decision at dispatch", and "The Core
  never guesses allowed or vetoed."
- Ch. 8 Charging, quoted under #271: a clause that can't pay "is never tried".
- [Ch. 6, Limit Faults](../../../spec/06-errors-and-limits.md#limit-faults):
  "a deciding Run that faults before its seal leaves its Decision undecided".

**Reviewer note:** no sentence says what happens to an _ordinary_ clause's
Decision when its dispatch charge fails. The change concludes that dispatch has
not happened until the clause is paid for, so nothing has allowed the Decision
and the fault leaves it undecided. Confirm that reading. If you disagree, the
Spec needs a sentence, not just the code.

**Evidence:** `decisions/script-verdict-boundaries`; TS test "ordinary
Decision dispatch must pay the complete first instruction" (`group.test.ts`).

- [ ] Confirmed against the Spec
- [ ] Disagree:

## #278: event tests pay no `clause` charge; Guard errors are recorded at observation

[PR #278](https://github.com/odogono/odgn-talk/pull/278), merged as `4af356b`.

**Before:** an event test's frame was marked as owing the 4-Fuel `clause`
charge, so a `load`, `list 1`, `return` test cost 11 Fuel. Guard errors raised
in an event test during observation weren't written to the Trace.

**After:** only a `handler` body owes `clause` (`clauseCharge: body.kind ===
'handler' && …` in [`machine.ts`](../../../impl/ts/src/machine.ts)), so that
test costs 7. Observation writes each waiter's new records, including
`guard-skip`, right after its test, before the incoming Run dispatches
(`writeRecords` in the observation loop of
[`group.ts`](../../../impl/ts/src/group.ts)).

**Spec basis:**

- Ch. 8 Charging, quoted under #271, and the
  [rates table](../../../spec/08-the-abstract-machine-and-the-cost-model.md#rates):
  `clause` is charged for "each Handler Clause a dispatch tries".
- [Ch. 8, The event table](../../../spec/08-the-abstract-machine-and-the-cost-model.md#the-event-table):
  a test body is "a body of kind `event`", and the Core runs it "charging it to
  the waiting Run".
- [Ch. 5, Fuel Slices](../../../spec/05-handlers-messages-and-scheduling.md#fuel-slices):
  "Observation finishes before any instruction of the incoming Run".
- [Ch. 11, What is recorded, and when](../../../spec/11-the-trace-and-conformance.md#what-is-recorded-and-when):
  records inside a Pump "follow in the order they happened", and a guard-region
  error "is written as `guard-skip`".

**Evidence:** `suspension/wait-observation` and the eight cases revised in
the [event-test charging record](../event-test-charging/README.md); TS tests
"event tests pay their instructions without a Handler Clause charge" and "event
Guard errors are recorded during observation before dispatch" (`wait.test.ts`),
and `event-test-fuel.test.ts`.

**Blessing exception:** four of those expectations
(`decisions/broadcast-outcomes`, `objects/wait-target`, `suspension/wait-for`,
`reload/extend-units`) were first re-blessed from TS ordinary and save/restore
agreement alone, with the maintainer's approval. Go later verified all four
([#277](https://github.com/odogono/odgn-talk/issues/277),
[PR #360](https://github.com/odogono/odgn-talk/pull/360)); see the
[event-test charging record](../event-test-charging/README.md#complete-parity-verification).
Nothing about that exception is still open.

- [ ] Confirmed against the Spec
- [ ] Disagree:

## #283: a Script send's reply wait is counted before suspension

[PR #283](https://github.com/odogono/odgn-talk/pull/283), merged as `d80d6b2`.

**Before:** the Persistent State check at a `send … and wait` suspension left
out the 48-byte pending reply. A sender with a 176-byte frame and the reply wait
(224 bytes) completed under a limit of 223.

**After:** `Run.suspend` in [`machine.ts`](../../../impl/ts/src/machine.ts) adds
`partSize('pending call')` for a Script send before it compares against the
limit. On a fault the reply is added to `faultAbandons`, so it is abandoned
after the fault record. The receiver keeps the message it has already accepted.
`faultNow` now appends to `faultAbandons` instead of replacing it.

**Spec basis:**

- [Ch. 8, Logical sizes](../../../spec/08-the-abstract-machine-and-the-cost-model.md#logical-sizes):
  "pending call | `48`". Each suspended Run counts "its frames, its pending
  calls and its Join's early answers".
- Ch. 8 Charging: "Suspension still charges its instruction and any Host effect
  before measuring the state it retains."
- [Ch. 6, Limit Faults](../../../spec/06-errors-and-limits.md#limit-faults):
  "Other effects already made in the Segment, such as … messages sent, are
  final", and "Pending calls … are abandoned."

**Evidence:** `limits/send-wait-retention`, `suspension/send-reply-preemption`,
`suspension/send-wait-replacement`; TS test "a paid Script send counts its
pending reply before suspending" (`send-wait-limits.test.ts`). The same omission
at non-Script suspensions (`ask`, foreign calls, event captures) was fixed under
[#281](https://github.com/odogono/odgn-talk/issues/281); see the
[suspension retention record](../suspension-retention/README.md).

- [ ] Confirmed against the Spec
- [ ] Disagree:

## #288: Join retention and replies during preemption

[PR #288](https://github.com/odogono/odgn-talk/pull/288), merged as `55b7a80`.

**Before:**

- At a Join's closing `end`, the retention check left out its 48-byte pending
  members.
- A Script reply that arrived while a Fuel Slice had preempted the Join's body
  found no pending entry yet. It was written as a late answer and lost.

**After:**

- The Run's size counts an open Join's members even before the suspension is
  installed. Each member counts as its reply, its early answer or a pending call.
- `replyToOpenJoin` buffers replies that arrive while the body is preempted.
  `takeJoinReplies` replays them in arrival order once the Join suspends.
- Buffered members are not abandoned on a fault.

The code is in [`machine.ts`](../../../impl/ts/src/machine.ts) and
`settleReply` in [`group.ts`](../../../impl/ts/src/group.ts).

**Spec basis:**

- [Ch. 5, Joins](../../../spec/05-handlers-messages-and-scheduling.md#joins):
  "Answers that arrive early count toward Persistent State while the Run waits",
  and "pending members count toward Persistent State".
- [Ch. 8, Logical sizes](../../../spec/08-the-abstract-machine-and-the-cost-model.md#logical-sizes):
  each "suspended, ready, parked or preempted Run" counts "its pending calls and
  its Join's early answers".
- [Ch. 6, Limits](../../../spec/06-errors-and-limits.md#limits): Persistent
  State counts "the answers a Join has received early".

**Evidence:** `limits/join-retention`, `suspension/join-preemption`,
`suspension/script-joins`, `limits/script-join-width`; TS tests "a Script-only
Join counts pending members at its closing end" and "a Script reply arriving
before a preempted Join closes is retained" (`script-joins.test.ts`).

- [ ] Confirmed against the Spec
- [ ] Disagree:

## #291: declared Operation charges are atomic

[PR #291](https://github.com/odogono/odgn-talk/pull/291), merged as `5eddb91`.

**Before:** an Operation call paid its Fuel (instruction plus declared Fuel),
then its declared allocation as a second charge. An allocation refusal left the
21 Fuel already spent, though no Host call was made.

**After:** `pay` takes an extra allocation, so the declared cost is charged
together with the instruction (`this.pay(key, { declared }, op.cost.alloc ?? 0)`
in [`machine.ts`](../../../impl/ts/src/machine.ts)). An allocation refusal now
costs 0 Fuel and 0 allocation, and makes no Host call.

**Spec basis:**

- Ch. 8 Charging: each instruction's Fuel and allocation are charged
  "together, when it runs … If either takes the Run past its limit, the Run has
  a Limit Fault at that instruction, before it does anything."
- [Ch. 9, Capabilities](../../../spec/09-embedding.md#capabilities): "The
  declared cost is charged before the Host function runs, and a Run that can't
  cover it has a Limit Fault at the call."

**Evidence:** `capabilities/declared-allocation`, `capabilities/ordinary-grants`;
TS test "an immediate Operation checks declared allocation together with call
Fuel" (`capability-costs.test.ts`).

- [ ] Confirmed against the Spec
- [ ] Disagree:

## Validation

Checked on 2026-10-07 at `12a35fb`:

- The focused TS test files named above pass.
- `go -C impl/go run ./cmd/corpus --check-passing` passes. It runs every case
  named above on Go, in ordinary and save/restore replay.

## Process

From now on, a behaviour change to one Core found during work on the other gets
its own issue, even when the fix ships in the same PR. See
[Cross-Core findings](../../agents/issue-tracker.md#cross-core-findings).
