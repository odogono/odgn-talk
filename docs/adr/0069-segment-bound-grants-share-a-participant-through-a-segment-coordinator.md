# Segment-bound Grants share a participant through a Segment Coordinator

ADR 0048 allows one participant per Segment and counts each named Grant as its own participant. Since the Store made writes Segment-bound (ADR 0050), an ordinary Script that writes to two Stores in one Handler, or to one Store through two aliases, raises `segment participant conflict`. So the participant becomes a Segment Coordinator, not a Grant: a Host object that holds `begin`, `commit` and `rollback`, and to which the Host maps each Grant's binding. Grants that map to one Segment Coordinator share the Segment's participant, and a Segment-bound call through a Grant that maps to another still conflicts. We chose this so the common conflicts disappear while a Segment still commits or rolls back as a whole, with no partial commit. Settled in [#228](https://github.com/odogono/odgn-talk/issues/228); [the lifecycle contract](../../spec/embedding/scoped-effects.md#segment-participant) holds the rules.

## Considered Options

- **Ordered commit with a definite-failure rule:** any number of independent participants commit in turn, but a definite failure after an earlier commit leaves effects partly published, which ADR 0048 rules out.
- **Keeping the limit and adding a load-time Lint:** two Stores in one Handler would still fail, only sooner.
- **Grouping Grants whose Capabilities share a lifecycle object:** it needs no new API, but merges a database Capability that opens a connection per binding and separates two `store` factories over one engine.
- **A coordinator key per binding:** when two Capabilities give the same key, nothing says whose `commit` runs. Making the coordinator the object that commits settles it.
- **An `enlist` hook when a Grant joins a begun coordinator:** it would let a coordinator refuse a join, which nothing needs; the coordinator sees each joining Grant on its Operation calls.
- **A Lint for the conflicts that remain:** a Grant's coordinator is Host data the loader can't see unless the Host Manifest declared it.

## Consequences

- **Mapping:** a Capability offering Segment-bound Operations maps each Grant's binding to a Segment Coordinator, once, when the Grant is created. The mapping is fixed for the Grant's life, across Reload and Restore. Native Hosts compare coordinators by object identity, and the Message Layer and `case.toml` by a Host-chosen `coordinator` name on the Grant. A Grant without one has its own coordinator, as every Grant had under ADR 0048, so the existing per-Capability lifecycle is shorthand for that.
- **Hooks:** `begin` runs once, at the Segment's first Segment-bound call through any of the coordinator's Grants, and no hook runs when another of its Grants joins. `commit` and `rollback` receive the enrolled Grants, with their bindings, in enrollment order. One coordinator may serve many Groups, Scripts and Runs at once, and tells their Segments apart by Group identity and Segment id.
- **Conflict:** `segment participant conflict` is raised for a Grant mapped to a different coordinator, and its `participant` field names the coordinator's first enrolled Grant.
- **Enrolled Grants:** where ADR 0048's rules speak of the participating Grant, they now mean any Grant enrolled in the participant. Failed abandonment on any of them prevents commit, and cancellation abandons scopes on all of them before rolling back. Disablement stays with the one named Grant whose abandonment failed.
- **The Store:** every Store kept by one Store implementation shares one coordinator, so writes to several Stores, or to one Store through two aliases, in one Segment never conflict, and commit together. A SQLite Store commits them in one transaction. The shared Host test kit checks this.
- **Across Capabilities:** a Host may map a Store and another Segment-bound Capability, such as a database over the same connection, to one coordinator ([#218](https://github.com/odogono/odgn-talk/issues/218)). No Standard Capability requires it.
- **Trace:** `effect` and `stub-effect` keep naming one Grant, now the coordinator's first enrolled Grant. The coordinator is outside the Group Fingerprint, as bindings and hooks are.
- Amends [ADR 0048](0048-segment-bound-effects-use-one-host-participant.md), whose participant is now a Segment Coordinator, and [ADR 0050](0050-the-store-is-a-standard-capability-with-segment-bound-writes.md), whose writes to two Stores no longer conflict.
