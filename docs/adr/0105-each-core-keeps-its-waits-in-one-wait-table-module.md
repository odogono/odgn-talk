# Each Core keeps its Waits in one Wait table module

A Core's Waits used to be spread across its Group and Runs. In the Zig Core, `machine.zig` kept them in seven Group fields, three flags on each suspending Call, 14 hand-written loops that removed a Wait, 15 places that abandoned a Call, and two copies of "is this Call still awaited?", one of them in `snapshot.zig`. Every new way for a Run to end had to remember each of these. When one was missed, it shipped as a bug: #1081, #1126, #1158, #1193 and #1205 were all a Wait or Call state that a distant exit path forgot to handle. Each Core now keeps its Waits in one module, the Wait table, and every other part of the Core asks it about Waits rather than reading their state directly ([#1218](https://github.com/odogono/odgn-talk/issues/1218)).

The Wait table owns:

- every Wait with its deadline, in the order the Waits began, and the Run's and Join Member's references to them;
- the next Wait due, by deadline and then by the order deadlines were set;
- the suspending Calls by id, whether a Call id was issued and is eligible for a Charge, and the Call kept alive while its Operation starts;
- abandoning a Wait, with a reason from a closed list. Hosts and saves never see the reason;
- whether anything still awaits a Call, and retiring Calls nothing can resume;
- writing its state into a save and rebuilding it on restore.

It does not own Charge requests and billing, Run scheduling, or the Trace. When a Wait is answered, the Wait table records the answer and returns the Run that became ready. The Group schedules that Run and writes the Trace records.

Hosts cannot observe the Wait table. Trace output, save bytes and the C API stay unchanged, and `Call.abandoned` stays an atomic that a Host may read from any thread. The spec does not mention the Wait table.

The Zig Core gets the Wait table first, because the recent bugs were there ([#1220](https://github.com/odogono/odgn-talk/issues/1220), [#1221](https://github.com/odogono/odgn-talk/issues/1221), [#1222](https://github.com/odogono/odgn-talk/issues/1222)). The TS Core keeps the same concepts in a different shape: its Group's `pending` map, each Script's `wait for` waiters, and suspending Calls held on the Run. It adopts the same module shape once Zig's has settled ([#1223](https://github.com/odogono/odgn-talk/issues/1223)). The Cores share no code: they answer to the spec ([ADR 0009](0009-twin-cores-held-to-bit-for-bit-parity.md)), and this ADR only gives them the same structure.

## Considered Options

- **A module for suspending Calls only**, leaving the Waits where they were: most of the removal loops serve `wait`, replies, `wait for` and Join Members, so they would stay scattered, and "is this Call still awaited?" would still need two places.
- **A module for Waits only**, leaving Calls where they were: it would miss the Call states that the recent fixes kept getting wrong.
- **Moving Run scheduling into the Wait table too**: scheduling and Trace records belong to the Group's turn loop, and the Trace has to stay byte-identical.
- **Specifying Waits in the spec**: Hosts cannot observe them, so the spec would gain rules that no conformance case could check.

## Consequences

- The Zig changes are refactors, with Trace output and save bytes identical and Wait order preserved, because `wait for` readies Waits in the order they began. Any real bug found while moving code ships as its own fix.
- The Wait table keeps the same data structures and performance characteristics. A faster index would be a separate change.
- The Wait table's own tests build bare Runs, with no Group or Script. The end-to-end tests and the Conformance Corpus stay as integration coverage.
