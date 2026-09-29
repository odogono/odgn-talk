# Durability is a deferred extension; long-lived processes are state plus events

Suspended Runs live only in memory in the v1 core. Unloading a Script, or the Host dying, is Stop Script, and replacing a Script's code is stop-and-reload. Long-lived processes (`wait 3 days`, `wait for approval`) are meant to be written as Host-owned state plus events, using durable timers and records the Host provides through Capabilities. In-memory `wait` is for short waits, enforced by the Host's maximum wait. But the spec keeps the door open to durable suspension as a later, optional Host extension. A Quiescent Script's complete state must always be expressible as a Script Snapshot: plain data plus Host Object handles, with no host-language closures, code referenced by stable position, pending `wait`s as absolute deadlines, and in-flight Capability calls identified by deterministic, spec-visible call ids. Every core must support a test-only `snapshot → restore` round trip that the conformance corpus exercises mid-suspension. We chose this because making durability a core feature would load every Host (the browser included) with versioned code identity, handle persistence, an in-flight call policy and a cross-core snapshot format. Workflow-style durability is better served by the Host, which already owns every effect. Without a written invariant, though, the runtime architecture could quietly bind suspended state to host promises or closures and close the door for good.

## Considered Options

- **Durability as a core feature** (workflow-engine model): every Host serialises and resumes suspended Scripts, possibly across processes. Rejected for its cost to every Host and the parity burden it puts on the conformance corpus.
- **Never:** suspension is purely in-memory and implementations may hold host state in frames. Rejected because it rules durability out forever for little saving, since ADR 0001 and ADR 0004 already make most state plain data.
- **Per-Run snapshots:** incoherent, because Runs share Script Variables (ADR 0004).

## Consequences

- A snapshot covers the whole Script and can only be taken while it is Quiescent. Pending `wait`s restored after their deadline become due at once, in deadline order.
- Events the Host doesn't deliver while a Script is unloaded don't exist for the Script. `wait for` still buffers nothing, and a missed `wait for` stays missed. Holding or dropping those events is Host policy in the extension.
- On restore the Host resolves the handle tokens it issued. A handle it can't resolve restores as a disposed Host Object.
- A snapshot is bound to one exact code version. When code is replaced, Script Variables reset by default, and a Host may opt to carry over those whose names still exist.
- When a Script is unloaded, the Host is told which suspended Runs were discarded. There is no `on unload` hook.
- Narrowed by ADR 0008: same-core save and restore of Quiescent Scripts is now a core feature. The stable cross-core format stays deferred.
- Settled by #71: the durable-timer pattern is the `timer` Standard Capability (ADR 0023). `tell timer to schedule name, at, message, args` and `tell timer to cancel name` are fire-and-forget, `at` is an Instant, and names are scoped per Script. Scheduling a name again replaces its timer, and cancelling an unknown name does nothing. The Host stores timers durably and, when one is due, delivers `message` with `args` to the Script as an ordinary Delivery, at its next opportunity if `at` has already passed. The Core has no part in it, and `wait` stays in memory only.
