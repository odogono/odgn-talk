# Scope guard charging reconciliation

The TS Core's generic Core-error path charged instructions rejected by lifecycle
guards. The guards already ran before Host work, but their errors did not carry
the internal flag that skips the instruction charge. They now do; an unpaid
Handler Clause still pays dispatch before the error unwinds.

The authority is [chapter 8's Charging rules](../../../spec/08-the-abstract-machine-and-the-cost-model.md#charging)
and the [lifecycle contract](../../../spec/embedding/scoped-effects.md#scope-ownership-and-calls),
with rates from [Cost Model 0](../../../spec/data/costs.toml).
There is no new rejection rate or specification change.

## Boundary audit

| Fixture / Handler | Rejected boundary | Previous Fuel | Corrected Fuel | Charge removed |
| --- | --- | ---: | ---: | --- |
| `scope-slots/go` | Duplicate `open`, missing `close` | 127 | 107 | Two `capability` bases of 10 |
| `scope-suspension-boundaries/b0` | Zero-duration `wait` | 64 | 54 | `wait`: 10 |
| `b1` | `wait-for` | 64 | 54 | `wait`: 10 |
| `b2` | Suspending Operation | 65 | 55 | `capability`: 10 |
| `b3` | Waiting send to `me` | 78 | 57 | `send`: 20 + ceil(32 / 32) = 21 |
| `b4` | Join whose conditional member would not execute | 67 | 57 | `join`: 10 at entry |
| `b5` | Join with a member | 68 | 58 | `join`: 10 at entry |
| `b6` | Local Handler reaches a zero-duration `wait` | 86 | 76 | `wait`: 10; local call and dispatch retained |
| `go` | Local wait-marked Handler takes a nonsuspending path | 52 | 52 | None |
| `joined` | Nested local Handler opens a scope inside a Join | 44 | 34 | `capability`: 10; Join entry, local call and dispatch retained |
| `effect-participant-conflict/go` | A second named Grant attempts enlistment | 31 | 21 | `capability`: 10 |

The waiting send's allocation falls from 172 to 140: its rejected message's
32 bytes are never allocated. All other allocation and Persistent State figures
stay unchanged, as do error fields, source/instruction positions, calls, scope
records, ids, outcomes and Host Inputs. The normal call's declared cost and
result conversion remain charged; no rejected call enters the Host or gets an id.

Operand and Grant validation still precede lifecycle guards. The audited
boundaries retain their duration, receiver, argument Shape and Function Value
validation. Instruction-specific limits remain before charging: local call
depth is checked before entering the callee, and Join member width before
member execution. Local wait-marked Handler and Function Value calls are allowed;
only their executed suspension boundaries fail. Waiting sends up the Message
Path, foreign Function Value calls and block-form `wait for` share the corrected
guard path. Scope and participant checks retain their existing order.

Dispatch costs 4 per attempted Handler Clause and unwind costs 4 per popped
frame. A first-instruction rejection caught in that frame still pays dispatch,
even though it unwinds no frame. Rejection before instruction Fuel/allocation
checks does not waive dispatch or unwind budget checks. Automatic abandonment
continues to consume no Script Fuel or allocation.

## Agreement and review

Before blessing, each scope fixture was executed independently through Go's
public Group replay backend, producing a complete Trace without changing
`case.trace`. Each was compared byte for byte with TS ordinary replay; TS's
save/restore replay produced the same Trace. Only then were the two scope
expectations written with the TS blessing command. Both cases are now required
by Go's scope acceptance test and `corpus-passing.txt`.

At the time of this audit, the participant-conflict fixture was checked in TS
ordinary and save/restore replay only; Go did not yet support Segment-bound
Operations. Since #340, Go also reproduces the corrected ordinary Trace. The
maintainer approved that case's first blessing for #326 on 2026-10-05; see the
[step-4 approval record](../go-step-four-blessings/README.md).
Its 21 Fuel is 4 dispatch + 12 for
the successful first call and Nothing conversion + 1 store into `it` + 4 unwind.
The conflicting second call contributes no instruction charge or Host work.

Verification passed: 2,680 TS Core tests, the full Go race suite, Go vet,
the 209-case Go passing gate, the default TS corpus run, lint, typecheck,
build, Spec/generator checks and changed-file formatting. An independent
code review found no blocking issues. The focused regressions were also run
against the original machine: 13 failed before the fix and all 14 passed after it.

The expectation corrections were reviewed and accepted by the user on
2026-10-05 for #323. The original first-review headers from #222 are preserved
verbatim; this acceptance does not approve that broader first blessing.

Reproduce the agreement with:

```sh
bun run corpus:run capabilities/scope-slots capabilities/scope-suspension-boundaries capabilities/effect-participant-conflict
bun test impl/ts/tests/scoped-conformance.test.ts
(cd impl/go && go run ./cmd/corpus capabilities/scope-slots capabilities/scope-suspension-boundaries)
(cd impl/go && go test ./internal/corpus -run TestScopeAcceptance)
(cd impl/go && go run ./cmd/corpus --check-passing)
```
