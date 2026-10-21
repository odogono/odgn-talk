# The TS Core keeps its save format in one module

The TS Core's save format used to live inside `group.ts`. `TsGroup.save` built the saved record, and `TsGroup.restore` decoded and checked it. A private `snapshotReferences()` built the reference table that the state graph names live objects through. `snapshot.ts` only held the graph mechanics. So every change to the save format landed in `group.ts`, the TS Core's largest file, and a test had to cast into the Group to get the reference table ([#1455](https://github.com/odogono/odgn-talk/issues/1455)).

`group-snapshot.ts` now owns the save format:

- the saved record's types, and its wire form with deduplicated Grant declarations and the content hash;
- encoding a Group's state, and decoding and checking a save (`encodeGroup`, `decodeGroup`);
- the format, language and Cost Model version checks, and the Library identity checks (`versionMismatch`);
- the reference table, built from the Group's Scripts and objects (`snapshotReferences`);
- resolving the state graph and checking the saved Run accounting (`restoreState`).

The Group keeps the parts that run its own behaviour. It refuses a save while effects are pending, writes the `save` and `restore` Trace records, and on restore loads each Script, rebinds Grants and objects, discards Runs for a variables-only restore and rebuilds Run hosts. The Group passes its state in, and gets decoded and checked values back. Wait state still goes through `waits.ts` (`exportState`, `importWaits`) as [ADR 0105](0105-each-core-keeps-its-waits-in-one-wait-table-module.md) set out.

Save bytes, the Trace and the embedding interface stay unchanged. The other Cores keep their own save code ([ADR 0009](0009-twin-cores-held-to-bit-for-bit-parity.md)).

## Considered Options

- **Moving all of restore out**: restore mostly calls Group behaviour (`load`, `applyExtension`, the accounting and discard steps, `hostFor`), so the module would need almost every private member, and the Group's interface would grow rather than shrink.
- **Leaving the format in `group.ts`**: format changes keep landing in the Group, and the reference table stays reachable only through a cast.

## Consequences

- A save-format change touches `group-snapshot.ts` and, if a new field needs it, the state the Group passes to `encodeGroup`.
- The module imports only types from `group.ts`, so there's no runtime import cycle.
