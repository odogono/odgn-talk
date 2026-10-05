# Event-test charging reconciliation

This record describes the staged verification of the correction in
[PR #278](https://github.com/odogono/odgn-talk/pull/278). Current support is
described in the [Go save/restore and Extend guide](../../../impl/go/README.md#save-restore-and-code-updates).
[PR #360](https://github.com/odogono/odgn-talk/pull/360) records complete follow-up
verification for [#277](https://github.com/odogono/odgn-talk/issues/277) below.

The Go `wait for` implementation exposed a TS dispatch overcharge. Chapter 8's
[Charging rule](../../../spec/08-the-abstract-machine-and-the-cost-model.md#charging)
adds the `clause` rate to Handler Clauses. Its
[event table](../../../spec/08-the-abstract-machine-and-the-cost-model.md#the-event-table)
charges an event test's own instructions to the waiting Run. A test containing
`load`, `list 1`, `return` therefore costs 7 Fuel, rather than 11. Reusing a
one-clause dispatch to make test failure end `unhandled` does not add a Handler
Clause charge. The TS correction also writes event Guard errors during
observation, as chapter 11 requires, before incoming Handler dispatch.

Four existing cases were revised only after actual Go and corrected TS Traces
agreed byte for byte: `decisions/dispatch-and-waits`,
`limits/event-tests-fault-on-resume`, `suspension/event-test-group-cap` and
`suspension/event-test-slice-debt`. TS's ordinary and save/restore replays agree
too. The new `suspension/wait-observation` regression also agrees in those runs.

Four further cases originally received corrected authoritative expectations
based on actual TS ordinary and save/restore agreement. The maintainer explicitly approved
applying these corrections before Go could execute the cases, as a limited
exception to chapter 11's [Bless rule](../../../spec/11-the-trace-and-conformance.md#bless).
That approval did not establish Go parity or change the rule for other cases.
Script sends, Broadcast Decisions and Object Message Paths later enabled actual
Go agreement for `suspension/wait-for`, `decisions/broadcast-outcomes` and
`objects/wait-target`. Step 5 (#136) supplied Extend and Go save/restore replay.

Each correction removes 4 Fuel per executed event test. The `run` totals and
receiving `pumped` totals decrease; the four cases originally corrected from
TS-only agreement have no observation-budget cutoffs whose scheduling changes.
Values, allocation and Persistent State stay the same. The authoritative case
files hold the verified output; the earlier candidate copies have been removed.

## Complete parity verification

At checkout `215be871630329844ddf9b84346fc7abfc477ba9` on 2026-10-05,
actual Go and TS execution reproduced all nine complete authoritative Traces
in both ordinary and save/restore replay. This completes the remaining
verification in [#277](https://github.com/odogono/odgn-talk/issues/277), including
extension-unit event tests in `reload/extend-units`. Exact record comparison
covers Run and Pump Fuel, allocation, Persistent State, ordering and final values;
no authoritative Trace record was changed.

| Corrected case or regression | Records |
| --- | --- |
| `decisions/dispatch-and-waits` | 32 |
| `decisions/broadcast-outcomes` | 37 |
| `limits/event-tests-fault-on-resume` | 26 |
| `objects/wait-target` | 23 |
| [reload/extend-units](../../../corpus/reload/extend-units/case.trace) | 32 |
| `suspension/event-test-group-cap` | 26 |
| `suspension/event-test-slice-debt` | 26 |
| `suspension/wait-for` | 37 |
| `suspension/wait-observation` | 60 |

Both corpus runners compare ordinary replay with save/restore between eligible
Pumps, subject to chapter 11's exclusions for old Host handles, and compare the
complete output with the authoritative Trace. Reproduce the verification from
the repository root:

```sh
go -C impl/go run ./cmd/corpus decisions/dispatch-and-waits decisions/broadcast-outcomes limits/event-tests-fault-on-resume objects/wait-target reload/extend-units suspension/event-test-group-cap suspension/event-test-slice-debt suspension/wait-for suspension/wait-observation
bun run corpus:run decisions/dispatch-and-waits decisions/broadcast-outcomes limits/event-tests-fault-on-resume objects/wait-target reload/extend-units suspension/event-test-group-cap suspension/event-test-slice-debt suspension/wait-for suspension/wait-observation
go -C impl/go test ./internal/corpus -run '^TestEventObservationAcceptance$' -v
go -C impl/go run ./cmd/corpus --check-passing
```

The Go `TestEventObservationAcceptance` test requires all nine cases to remain in
the passing gate and reproduces their complete Traces in both modes. All 276
cases in the committed Go gate also passed on both Cores at that checkout,
protecting every earlier passing case. The initial full race run exposed a
pre-existing `sessions/argument-labels` failure: the Go Session Host classified
labelled calls by the complete Selector instead of its first word.
[PR #359](https://github.com/odogono/odgn-talk/pull/359) supplied the correction,
passing-gate entry and eleven-Transcript acceptance count on `main`. PR #360
retains an additional regression for labelled/positional calls and redefinition
of one Selector while preserving the others. The updated 277-case Go gate and
full Go race suite pass with that correction.
`suspension/wait-observation` retains its `Unblessed` header;
replay agreement does not approve its first blessing.
