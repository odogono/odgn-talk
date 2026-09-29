# Same-core save and restore is a core feature, and a restore is unobservable

This narrows ADR 0005. Every core (TS now, Go later) must be able to save a set of Quiescent Scripts, taken at one instant, and restore it on the same core family, so a game Host like the Damocles port can save anywhere. Quiescent now includes a Run preempted at a time-slice boundary. So a pause that lands while a per-tick Fuel slice has cut a Run mid-Segment can still be saved, and the preempted Run keeps its Segment's rollback base (ADR 0006). The core has no notion of "paused": saving is legal whenever the Scripts are Quiescent. The governing invariant is that **save then restore is unobservable**. Given the same later inputs, a restored Script produces the same results, uses the same Fuel and faults at the same step as one that was never saved. So the save records every Run's Fuel and Allocation Budget use, Persistent State size, per-Script counters, the position in the current tick's Fuel slice and the last Clock reading, all exactly. In-flight Suspending Capability calls are recorded by call id, Capability and arguments, and on restore the Host settles each one. Host Objects are saved as stable ids the Host supplied. A save is bound to its versions: an exact match restores fully, and anything else is rejected or restored as Script Variables only. We chose this because save-anywhere is a product requirement for Damocles, and the ADR 0005 invariant already makes the state plain data. Keeping the format core-specific and version-bound avoids the stable cross-core format and frame migration that made full durability too costly. Resetting counters on restore would let a Script use save/load to launder Fuel.

## Considered Options

- **Save only when the Script is strictly Quiescent** (no preempted Runs): the Host might need ticks the paused game isn't delivering before a save becomes possible.
- **Roll back the in-progress Segment and save from its start:** replays Immediate Capability effects the Segment already made.
- **Drain or fail in-flight calls:** draining makes a save wait on the Host, and failing every call on restore breaks save-anywhere for ordinary game Capabilities (`play animation and wait`).
- **Core-assigned handle tokens made at save time:** moves id bookkeeping into the core when the Host already owns the objects' identities.
- **Migrate suspended frames across Script, Cost Model or core versions:** unbounded work for every core, and fragile. Variables-only restore reuses the ADR 0005 reload rule instead.
- **Per-Script saves only:** every cross-Script `send … and wait` would fail on restore.

## Consequences

- **Timing:** a preempted Run is saved mid-Segment, together with the Script Variable bindings at its Segment's start, so a later Limit Fault still rolls back correctly.
- **In-flight calls:** on restore the Host settles each recorded call id by answering it, re-issuing it or failing it with an ordinary error. A call it doesn't settle fails. A re-issue isn't charged its per-call cost again, but converting its result is charged as normal.
- **Host Objects:** each carries a stable id, supplied by the Host when the object first crosses into a Script. A duplicate id is a Host error. On restore, an id the Host can't resolve restores as a disposed Host Object.
- **Versions:** a save is stamped with the Script code identity, the Cost Model version and the core's save-format version. On a mismatch the Host chooses between rejecting it and a **variables-only restore**: Script Variables carry over by name, and the mailbox and suspended Runs are discarded and reported. That restore fails as a whole if the carried-over variables would exceed the Persistent State cap. Per-Script counters carry over.
- **Clock:** on restore the Host supplies a Clock at or after the saved reading, and a Clock that has gone backwards is a Host error. A game Host resumes at the saved game time. Overdue `wait`s fire at once, in deadline order (ADR 0005).
- **Sets of Scripts:** a save covers whole Script Groups (ADR 0009). A `send … and wait` pair inside the saved set restores intact. A sender whose partner is outside the set fails with an ordinary error. Messages already sent outside the set are not part of the save.
- **Text Patterns:** Text Pattern values are saved in source form and recompiled on restore at no Fuel cost.
- **Format:** the format is unstable across core families, and a TS save never restores on the Go core. The cross-core durable format stays deferred (ADR 0005).
- **Conformance:** the corpus checks that saves are unobservable, including preempted Runs, pending calls, cross-Script pairs and variables-only restores.
- Narrowed by ADR 0015: a pending call can also be settled by **adopt**, meaning the Host still has it in progress and will answer it under the same call id. Adopting costs nothing.
- Narrowed by ADR 0018: every corpus case is also replayed with a save and restore between each pair of Pumps, and must give identical output.
- Narrowed by ADR 0025: a Function Value is saved as plain data (Home Script, literal, captured values). A variables-only restore keeps it, but it is stale, and calling it raises `function gone`.
