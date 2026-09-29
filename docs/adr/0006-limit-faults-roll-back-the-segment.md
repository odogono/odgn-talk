# Resource limits are uncatchable Limit Faults that roll back the failed Segment, under a normative Cost Model

Every resource a Script uses is metered by a versioned, normative Cost Model, the same in every core: exact Fuel per operation, model sizes per value kind, per-unit costs for bulk work (text length, decimal digits, Quantity conversion, Text Pattern NFA steps, Handler Clauses tried during dispatch). Budgets are per Run: Fuel and an Allocation Budget covering the Run's whole life, suspensions included, plus a cap on the Script's Persistent State. Exceeding any limit is a Limit Fault. A Script can never catch it. The Run ends, and the failing Segment is rolled back, so Script Variables return to their bindings at the Segment's start. Other Runs of the Script carry on. We chose this because a catchable limit turns a hard sandbox into a soft one (`try` inside a loop). Leaving partial writes behind would let an exhausted Run break a healthy Script's invariants. And the conformance corpus can only pin down the exact exhaustion point if both cores charge from the same table. Value Semantics (ADR 0001) makes rollback cheap: keep the old root bindings.

## Considered Options

- **Catchable resource errors:** rejected, because recovery code would let a Script run past its budget.
- **Keep partial Segment writes on a Limit Fault:** simpler, but leaves Script Variables half-updated for later Runs.
- **Stop the whole Script on a Persistent State breach:** rejected in favour of rolling back the Segment that caused it, so the Script never sits above its cap and one oversized Run doesn't kill it.
- **Abstract costs with parity only:** leaves the exhaustion point implementation-defined, which the corpus can't check.
- **Per-Segment budgets, or a Script-level Fuel account the core refills:** the first lets one Run burn unbounded Fuel slowly, and the second puts refill policy and time into the core. Cumulative quotas are Host policy, fed by read-only per-Script counters.

## Consequences

- Rollback covers Script state only. Effects already made through Immediate Capabilities in the failed Segment are final. A Host that needs all-or-nothing effects offers a staging Capability.
- Because the failed Segment leaves no trace in Script state, Stop Script and cancel-Run can take effect at any step without making that step observable.
- Capabilities are charged by the same rules: a declared per-call cost, plus a budget handle to charge in proportion to their work before doing it. Converting a result into Script values is charged to the calling Run. A pending Suspending Capability costs no Fuel, but its suspended frames count toward Persistent State.
- The scheduler observes the Host's Clock only at scheduler boundaries, so per-Run deadlines are deterministic given the sequence of Clock readings. The conformance corpus runs on a virtual Clock.
- Changing a cost is a new Cost Model version, not a silent retune.
- Narrowed by ADR 0017: ordinary errors are caught with `try`/`catch` and roll nothing back. A cancelled Run runs its `finally` blocks after the rollback, on a separate Cleanup Budget. A Limit Fault runs none.
- Narrowed by ADR 0026: starting a Join Member past the Host's `MaxJoin` is a Limit Fault. The Segment rolls back, and the members already started are abandoned.
