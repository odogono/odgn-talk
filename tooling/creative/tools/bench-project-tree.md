# ProjectTree write benchmark

Run from the repository root:

```sh
bun tooling/creative/tools/bench-project-tree.ts --check
```

The fixture is one Page with a 1,000-node group, including a rich-text Element
with 100 paragraphs, five runs per paragraph and 100 characters per run.
Each workload makes 120 updates through `StackEditor`: a group drag through
`startMove`, or rich-text replacements in one pending edit. Each sample starts
with a fresh editor. The output reports the median of five samples, including
finishing the edit but excluding fixture construction, snapshots and undo/redo.
Every sample also verifies exact undo and redo. These are Bun editor/model
measurements, excluding browser input handling, DOM rendering and paint.

The baseline at `0dfe4827`, measured on macOS arm64 with Bun 1.4.3 for #1233,
was approximately 113 ms for drag and 42 ms for typing. Drag made no deep
clones or JSON serializations; typing made 360 deep clones and 120
serializations. With incremental writes, the same harness measured roughly
30–44 ms for drag and 9–11 ms for typing. Timing is advisory and varies with
JIT warmup and machine load; the deterministic budgets are enforced by `--check`:
drag makes no deep clones, typing makes one intake clone per update plus two
history endpoint clones at finish, and neither workload serializes Fuel work.

The fixes remove repeated journal folding, whole-outer-group geometry copies,
per-node traversal arrays, and Edit's Fuel accounting. History retains
atomically replaced field values during a pending edit, then detaches and
freezes its completed endpoints. Play continues to maintain metered subtree
copy work before authorizing clone operations. Name repair and subtree edits
update affected indexes; adding, removing or reordering Pages preserves
retained Pages' indexes. Adoption validates the incoming hierarchy once and
uses the same incremental mutations.

A group move still visits its moved descendants, and ancestor bounds inspect
direct siblings. Updating a Page's postorder list still shifts its tail.
Structural history still records sibling keys and affected subtree payloads;
this benchmark does not claim constant-time structural edits or adoption.
