# Recovery Offers runtime expectation review (#388)

Approval status: **pending human review**. These are concrete candidate updates,
not a record of blessing approval. Language remains 1.0-rc.2 and Cost Model 0.
The integration base is `cdee6bf` (slice 1, #387 / PR #394).

Every ordinary catch now searches before cleanup. `catch-accept` adds 1 Fuel;
`catch-next` costs 1 and replaces the old load/rethrow pair. Dispatch contexts
retain failed frames while testing, and scratch slots cannot reuse temporaries
still live in those frames. This changes preemption-state sizes, instruction PCs,
Guard/cleanup ordering and some Fuel-limit fault positions. Uncaught Error-mode
cleanup retains its raise record; decline/accept/offer transfer adds no synthetic
raise. New offer metadata costs no Fuel on the normal path.

Candidates were derived by executing the same Host Inputs through the TS Core,
including transparent Save/Restore between Pumps. Existing comments and inputs
were retained; no `--bless` command was used. Go checks independently compare
canonical disassembly and full ordinary/restored Traces with these files. The
checks are execution evidence; approval is a separate step required by issue
#388 and [chapter 11](../../../spec/11-the-trace-and-conformance.md#bless).

## New cases (unblessed)

| Case | Coverage |
| --- | --- |
| [recovery-offers/basic](../../../corpus/recovery-offers/basic/case.trace) | Nested Libraries, same-Run callback, `[5, 7]` / `[5, 0, 7]`, retained accumulation, helper/Guard queries, invalid choices, attempt 1/2, Guard skip → choice → cleanup raise → entry ordering |
| [recovery-offers/boundaries](../../../corpus/recovery-offers/boundaries/case.trace) | Foreign callback starts a Home Run; caller offers remain outside it |
| [recovery-offers/costs](../../../corpus/recovery-offers/costs/case.trace) | Fuel 20 before choice, atomic 13-Fuel choice/lookup, exact state, slice debt, one entry across transparent replay |
| [recovery-offers/cleanup-restore](../../../corpus/recovery-offers/cleanup-restore/case.trace) | Fuzz-derived ordinary catch-body/cleanup replacement, restored context identity, original `during`, fresh error backstop with no offers |
| [disassembly/recovery-offers](../../../corpus/disassembly/recovery-offers/recovery.dis) | Every new opcode, nested-before-enclosing records, parameter slots and canonical empty bindings |

Shared standalone regression sources are in
[recovery-cases.json](../../../tools/machine/recovery-cases.json). Both Cores run
them independently. They cover rejecting/catch-all barriers, decline writes,
pre-cleanup state, nearest recursion/shadowing/arity, argument order, malformed
queries, action finally protection, ordinary acceptance cleanup replacement,
retained caller scratch, and cleanup-local rejection. Native tests also pin
lookup failure at Fuel 32, first action failure at Fuel 33, 48-byte activation
retention and retained real-frame call depth. [recovery-boundaries.json](../../../tools/machine/recovery-boundaries.json) additionally pins atomic raise/search, catch acceptance, catch-next and outward-search Fuel faults with exactly one original raise.

## Existing candidate expectation diffs

Each link below is a changed expectation file; the PR diff supplies its exact
before/after. Existing first-blessing markers remain intact. Existing approvals
do not approve this new runtime-derived change.

| Expectation | Changed figures or records |
| --- | --- |
| [builtins/function-values/case.trace](../../../corpus/builtins/function-values/case.trace) | fuel |
| [builtins/object-kind/case.trace](../../../corpus/builtins/object-kind/case.trace) | fuel |
| [capabilities/argument-shapes/case.trace](../../../corpus/capabilities/argument-shapes/case.trace) | fuel |
| [capabilities/effect-begin-failed/case.trace](../../../corpus/capabilities/effect-begin-failed/case.trace) | fuel |
| [capabilities/effect-operation-error/case.trace](../../../corpus/capabilities/effect-operation-error/case.trace) | fuel |
| [capabilities/host-failures/case.trace](../../../corpus/capabilities/host-failures/case.trace) | fuel |
| [capabilities/ordinary-grants/case.trace](../../../corpus/capabilities/ordinary-grants/case.trace) | fuel |
| [capabilities/revoke-in-flight/case.trace](../../../corpus/capabilities/revoke-in-flight/case.trace) | fuel |
| [capabilities/revoke-reissue/case.trace](../../../corpus/capabilities/revoke-reissue/case.trace) | fuel |
| [capabilities/scope-failed-close/case.trace](../../../corpus/capabilities/scope-failed-close/case.trace) | fuel |
| [capabilities/scope-slots/case.trace](../../../corpus/capabilities/scope-slots/case.trace) | fuel |
| [capabilities/scope-suspension-boundaries/case.trace](../../../corpus/capabilities/scope-suspension-boundaries/case.trace) | fuel |
| [capabilities/standard-console-timeout/case.trace](../../../corpus/capabilities/standard-console-timeout/case.trace) | fuel |
| [collecting/partial-error/case.trace](../../../corpus/collecting/partial-error/case.trace) | fuel |
| [computed-sends/bad-names/case.trace](../../../corpus/computed-sends/bad-names/case.trace) | fuel |
| [computed-sends/unhandled/case.trace](../../../corpus/computed-sends/unhandled/case.trace) | fuel |
| [disassembly/errors-and-loops/flow.dis](../../../corpus/disassembly/errors-and-loops/flow.dis) | catch opcodes, scratch slots, PCs and Unwind ranges |
| [errors/lambda-capture-parity/case.trace](../../../corpus/errors/lambda-capture-parity/case.trace) | fuel |
| [libraries/caller-capabilities/case.trace](../../../corpus/libraries/caller-capabilities/case.trace) | fuel |
| [libraries/errors/case.trace](../../../corpus/libraries/errors/case.trace) | fuel |
| [limits/mailbox-depth/case.trace](../../../corpus/limits/mailbox-depth/case.trace) | fuel |
| [limits/max-wait-minimum/case.trace](../../../corpus/limits/max-wait-minimum/case.trace) | fuel |
| [objects/properties/case.trace](../../../corpus/objects/properties/case.trace) | fuel |
| [save-restore/preempted-join-keeps-pending-members/case.trace](../../../corpus/save-restore/preempted-join-keeps-pending-members/case.trace) | fuel, state |
| [save-restore/settle-answer-and-fail/case.trace](../../../corpus/save-restore/settle-answer-and-fail/case.trace) | fuel, state |
| [save-restore/settle-reissue-and-adopt/case.trace](../../../corpus/save-restore/settle-reissue-and-adopt/case.trace) | fuel, state |
| [save-restore/unbound-grant-and-unresolved-object/case.trace](../../../corpus/save-restore/unbound-grant-and-unresolved-object/case.trace) | fuel |
| [save-restore/unsettled-call-is-lost/case.trace](../../../corpus/save-restore/unsettled-call-is-lost/case.trace) | fuel, state |
| [stdlib/errors-name-the-call/case.trace](../../../corpus/stdlib/errors-name-the-call/case.trace) | fuel |
| [stdlib/template-migration/case.trace](../../../corpus/stdlib/template-migration/case.trace) | fuel |
| [suspension/answers/case.trace](../../../corpus/suspension/answers/case.trace) | fuel, state |
| [suspension/capability-resumption/case.trace](../../../corpus/suspension/capability-resumption/case.trace) | fuel |
| [suspension/join-closing-position/case.trace](../../../corpus/suspension/join-closing-position/case.trace) | fuel |
| [suspension/joins/case.trace](../../../corpus/suspension/joins/case.trace) | fuel, state |
| [suspension/nested-waits/case.trace](../../../corpus/suspension/nested-waits/case.trace) | fuel |
| [suspension/script-joins/case.trace](../../../corpus/suspension/script-joins/case.trace) | fuel, state |
| [suspension/script-sends/case.trace](../../../corpus/suspension/script-sends/case.trace) | fuel |
| [suspension/send-and-wait/case.trace](../../../corpus/suspension/send-and-wait/case.trace) | fuel, state |
| [suspension/send-reply-preemption/case.trace](../../../corpus/suspension/send-reply-preemption/case.trace) | fuel, state |
| [text-model/chunk-write-out-of-range/case.trace](../../../corpus/text-model/chunk-write-out-of-range/case.trace) | fuel |
| [text-patterns/splice-wrong-kind/case.trace](../../../corpus/text-patterns/splice-wrong-kind/case.trace) | fuel |

## Delivery boundary

This is slice 2 against `feat/recovery-offers`, not the final merge to `main`.
Nested recovery and cancellation scope enumeration belong to #389; complete
snapshot phase/reference validation belongs to #390; debugger/session/Playground
integration belongs to #391. Existing ordinary Save/Restore regressions remain
passing, including shared owner locals reconstructed by the Go private codec.
The final conformance/blessing audit remains #392.

## Verification (2026-10-06)

`bun run check`, `bun run go:check`, full workspace tests, typecheck, lint and
format checks pass. Go full `-race` tests and `vet` pass. Both corpus runners
agree on all 41 changed existing expectation cases and five new unblessed
cases, including their ordinary/restored replay paths. The Go passing gate
passes. Dual-Core fuzz smoke completed all 64 seed-1 cases with zero findings.
Independent review found no remaining slice-2 issue after the shared scratch,
cleanup replacement, restored context and retained operand regressions passed.
