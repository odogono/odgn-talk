# Metered Operations authorize work through the Pump

An Operation whose cost depends on its results should not have to reserve its maximum cost before starting. For [#472](https://github.com/odogono/odgn-talk/issues/472), Metered Operations authorize bounded chunks before doing them: synchronous callbacks use repeated `Charge`, and pending read-only calls queue requests that the Pump admits in Host Input order. The first refusal ends the whole Run; accepted Fuel stays spent. [The metering contract](../../spec/embedding/metered-operations.md) holds the rules.

## Considered Options

- **Post-work billing:** simpler for row counts, but an exhausted Run has already consumed the work it could not afford. Authorization happens before each chunk instead.
- **Charge asynchronously against shared mutable counters:** gives immediate answers, but introduces synchronization and budget arbitration outside the Pump. Queued admission gives concurrent Join Members a replayable order and updates existing Run accounting without reentrant Host callbacks.
- **Reserve a private budget for each pending call:** reduces Pump round trips, but locks Fuel away from siblings and introduces refunds and reservation recovery. Each request instead waits for its own outcome; acceptance is spending, not a refundable reservation.
- **Require every metered call to be Segment-bound:** excludes read-only queries. Read-only Operations may meter synchronously or asynchronously; metered writes must remain immediate and Segment-bound. Extending transactions across suspension would change commit and isolation semantics, so it is outside this decision.
- **Save live metered calls:** requires preserving both external progress and outstanding work permissions. Save instead refuses for pending asynchronous metered calls or unresolved requests, including stale requests whose futures have not settled.

## Consequences

Hosts declare metering eligibility, stop on refusal and honor cancellation even after acceptance. The Core validates combinations but cannot prove arbitrary Host code is read-only or cooperative. Metering adds no Script syntax and does not bound a chunk's internal CPU time.

Synchronous Trace records retain aggregate accepted charges and explicitly record refusal. Asynchronous requests and outcomes are recorded individually. This preserves replay without exposing the Host's synchronous internal loop. Charge-only Pumps contribute to public Run accounting and scheduling debt; no synthetic Segment is needed.

This amends [ADR 0070](0070-sqlite-is-an-optional-standard-capability-with-segment-bound-writes.md): SQLite charges `perStep` before every statement step, including completion and overflow probes, instead of `max × perRow` before execution. An empty result still costs a step. This deliberately meters attempts, not just returned rows or SQL VM work. The factory supplies the charging callback, and the driver invokes it at each step. Query remains read-only and change remains Segment-bound.

This extends [ADR 0049](0049-live-host-effects-prevent-saving.md)'s Save refusal boundary and uses [ADR 0065](0065-run-accounting-is-returned-to-every-host.md)'s cumulative accounting rather than a separate Host-work counter. Runtime delivery and executable catalogue activation are recorded in the [implementation handoff](../handoffs/472-metered-operations.md).
