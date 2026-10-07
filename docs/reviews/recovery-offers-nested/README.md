# Nested Recovery Offers expectation review (#389)

Approval status: **pending first-blessing review**. Language remains 1.0-rc.2
and provisional Cost Model 0. This slice starts at `49a35dde` (PR #396 merged
into `feat/recovery-offers`). Runtime agreement does not bless expectations;
new cases keep their Unblessed markers through the final audit in #392.

Both Cores now bound nested policy failures to their selection continuation,
exclude the original failure's offers, and resume locally handled policy.
Escape adds `during` only when absent, bypasses sibling catches and cleans
policy scopes before the original retained scopes. Transfer cleanup permits
local handling and cancels a choice on escape. Actions expire sibling offers,
retain their offering finally, and may suspend in an eligible Handler body.

Cancellation scans dispatch-local and retained scopes once, using control plus
cleanup entry as identity. An activation inherits enclosing scope identities.
Cancellation does not restart an already entered cleanup copy; it rolls back
the interrupted Segment and runs remaining scopes on Cleanup Budget. Owner
locals remain retained and counted even when only policy-local cleanup needs
them. Search charges no synthetic activation unwind; lookup counts a real
owner once. These are implementation corrections at the existing rates.

## New candidates

| Case | Evidence |
| --- | --- |
| [nested](../../../corpus/recovery-offers/nested/case.trace) | Isolated local policy offers, policy escape and `during`, multiple finally scopes, local/escaping transfer cleanup, chosen without entry, sibling expiry |
| [cancellation](../../../corpus/recovery-offers/cancellation/case.trace) | Cancellation in tests, policy and transfer; scope order, rollback, Stop and Limit Fault, sliced cleanup with shared locals |
| [action-suspend](../../../corpus/recovery-offers/action-suspend/case.trace) | Policy/action immediate effects, legal Handler action wait/resumption, offering finally after action |

Candidates are replay-derived without `--bless`. Both Cores compare the complete
ordinary and transparent Save/Restore Traces. No prior expectation is blessed
or replaced by this slice. The [TS](../../../impl/ts/README.md) and
[Go](../../../impl/go/README.md) guides describe current support; subsequent merged PRs #401 and #405 delivered snapshot validation and
debugger/session integration. The [final review](../recovery-offers-integration/README.md)
consolidates first-blessing approval for #392.

Shared standalone [nested cases](../../../tools/machine/recovery-nested-cases.json)
add consecutive selection-boundary escape and exact 46-Fuel same-owner policy
escape and 58-Fuel helper escape without charging its retained continuation twice.
Native tests cover nested cancellation, Cleanup Budget exhaustion,
1220-byte retained owner state without an owner finally, real call depth and
existing atomic search/choice/entry boundaries.

## Verification

Focused TS recovery tests pass (64 tests); Go recovery tests and the explicit
acceptance gate pass. Both corpus runners agree on the three new unblessed
candidates, including ordinary and restored paths: 18 nested scenarios, seven
cancellation scenarios and one action suspension scenario. Corpus formatting
checks all 303 cases. Independent five-axis review found and verified fixes for
synthetic/duplicate unwind costs, owner-local accounting, queued cancellation
operands and cleanup Errors accidentally accepting inherited activation catches.
No required review finding remains. Full-suite results are recorded in the PR.
