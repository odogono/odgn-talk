# Event-test charging reconciliation

This record describes the staged verification of the correction in
[PR #278](https://github.com/odogono/odgn-talk/pull/278). Current support is
described in the [Go save/restore and Extend guide](../../../impl/go/README.md#save-restore-and-code-updates). [Issue #277](https://github.com/odogono/odgn-talk/issues/277)
tracks the follow-up verification of these corrected Traces.

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
At the initial correction, Go save/restore was not yet implemented.

Four further cases have corrected authoritative expectations based on actual
TS ordinary and save/restore agreement. The maintainer explicitly approved
applying these corrections before Go could execute the cases, as a limited
exception to chapter 11's [Bless rule](../../../spec/11-the-trace-and-conformance.md#bless).
Their headers record that exception; it does not claim Go parity or change the
rule for other cases. [Issue #277](https://github.com/odogono/odgn-talk/issues/277)
tracks the remaining Go verification. The corrected `suspension/wait-for` case
now agrees on actual Go execution after non-waiting Script sends were added;
its records and TS save/restore replay also agree. This paragraph records ordinary Go execution, not a later Go save/restore verification.
`decisions/broadcast-outcomes` now also agrees on actual Go execution after
Broadcast Decisions were added; its reviewed expectations remain unchanged.
`objects/wait-target` likewise agrees after Object Message Paths were added.

| Corrected case | Verification follow-up |
| --- | --- |
| [reload/extend-units](../../../corpus/reload/extend-units/case.trace) | Go ordinary and save/restore replay; `Extend` and save/restore are now implemented (see the Go guide above) |

Each correction removes 4 Fuel per executed event test. The `run` totals and
receiving `pumped` totals decrease; these four cases have no observation-budget
cutoffs whose scheduling changes. Values, allocation and Persistent State stay
the same. The authoritative case files now hold the verified output; the earlier
candidate copies have been removed.
