# Event-test charging reconciliation

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
The Go save/restore implementation is still deferred to #136.

The files below are proposed corrections, **not blessed expectations**. They
come from actual corrected TS execution; each ordinary Trace matches its
save/restore replay. Their authoritative `corpus/**/case.trace` files retain
their previously reviewed records, because Go cannot execute the other required
facilities yet. Consequently the full TS corpus command still reports these
four divergences. The Trace replay debugger suite also fails on these same
four expectations; its other 1,199 tests pass. [Issue #277](https://github.com/odogono/odgn-talk/issues/277)
tracks reconciliation, and the implementation PR remains draft.

| Authoritative case | Proposed correction | Required Go facility |
| --- | --- | --- |
| [decisions/broadcast-outcomes](../../../corpus/decisions/broadcast-outcomes/case.trace) | [candidate](decisions-broadcast-outcomes.candidate.trace) | Broadcast Decisions, #134 |
| [objects/wait-target](../../../corpus/objects/wait-target/case.trace) | [candidate](objects-wait-target.candidate.trace) | Object routing, #134 |
| [suspension/wait-for](../../../corpus/suspension/wait-for/case.trace) | [candidate](suspension-wait-for.candidate.trace) | Script sends, #134 |
| [reload/extend-units](../../../corpus/reload/extend-units/case.trace) | [candidate](reload-extend-units.candidate.trace) | Reload/extension units, #136 |

Each candidate removes 4 Fuel per executed event test. The `run` totals and
receiving `pumped` totals decrease; these four cases have no observation-budget
cutoffs whose scheduling changes. Values, allocation and Persistent State stay
the same. Chapter 11's
[Bless rule](../../../spec/11-the-trace-and-conformance.md#bless) requires every
available Core to agree before authoritative expectations are written. This
review directory preserves the proposed output without bypassing that rule.
