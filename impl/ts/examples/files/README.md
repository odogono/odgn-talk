# File Example Host

This Bun Host runs the two file examples in the [Capability lifecycle contract](../../../../spec/embedding/scoped-effects.md#file-handle-cleanup) against real temporary files. From the repository root, using Bun 1.4.2:

```sh
bun install
bun impl/ts/examples/files/main.ts
bun test impl/ts/examples/files/files.test.ts
```

Each scenario starts with `report.txt` containing `old bytes` in a fresh Host-owned temporary directory. The Host loads a matching `.talk` Script with the named `output` Grant and delivers `export "new bytes"`. The directory and all its files are removed afterward. No path supplied by the user is used.

| Host and Script | After the first Pump | At Run end |
| --- | --- | --- |
| Immediate, `fault-open.talk` | New bytes visible, handle open | Limit Fault closes the handle; new bytes remain |
| Staged, `export.talk` | Explicit close has run, old bytes still visible | Completion publishes new bytes once |
| Staged, `fault-closed.talk` | Explicit close has run, old bytes still visible | Limit Fault preserves old bytes and discards staging |
| Staged, `unfinished.talk` | Run already ended with an ordinary error | Automatic close discards the unfinished output; Segment commit publishes nothing |

The extra loop in `export.talk` lets the Host inspect the closed but provisional file after Fuel Slice preemption. It has no publication semantics. The same open/write/close Script works with either Host mode.

## Ownership and operations

[`host.ts`](host.ts) declares immediate `open`, `write` and `close` Operations. `open` opens the Run-owned `file` scope and `close` closes it; automatic abandonment calls the same `close` with `automatic: true`. Scripts receive Nothing, never a descriptor or a resource handle. `write` outside an open scope returns the declared `file not open` error.

The Host binds the Capability implementation to its private directory. Scripts may name only plain output filenames starting with an ASCII letter or digit; directories, parent paths, absolute paths and the internal `.stage-` names are rejected. The directory must remain private to this Host, with no external writers or inserted symlinks. This is a small Example Host, not a general filesystem Library.

Resources are indexed by Group object identity, Script, Run, named Grant and the fixed `file` scope. Only one handle occupies each slot. A destination remains reserved across preemption, until ordinary close or staged Segment finalization, so another Run, Grant alias, Script or Group sharing this Host cannot overwrite a live output. A failed automatic cleanup retains the reservation; a Host operator must repair that resource before reuse.

In immediate mode, `open` truncates the destination and `write` changes it directly. Closing only releases its handle. In staged mode, all three Operations are Segment-bound. `begin` creates participant state; `open` creates a same-directory temporary file, and explicit `close` marks it ready without publication. Automatic `close` instead closes and discards it. `rollback` discards staging; `commit` publishes only a ready file. An ordinary error after explicit close commits, while an ordinary error with an unfinished file discards that file before the enclosing Segment commits.

Each Segment permits one destination. A second destination returns `destination conflict` before creating or changing a file. After explicit close, reopening the same destination truncates only its staging file. A subsequent Segment may choose another destination.

## Storage contract and limits

The default publisher requires a **local POSIX filesystem** supporting atomic same-directory replacement with synchronous `rename`. Staging is in the destination directory, so publication is one rename with no cross-filesystem move. A successful rename returns `ok`. Recognized local POSIX rename errors that leave the destination unchanged return `failed`; the Core rolls back staging and ends the Run with `effect failed`. `EIO`, unrecognized errors and exceptions are uncertain: the Core attempts cleanup and stops the Group with `effect state unknown`, without retrying publication. The [POSIX rename contract](https://pubs.opengroup.org/onlinepubs/9799919799/functions/rename.html) is the basis for this classification.

`FileHostOptions.publish` is a Host-only test seam for definite or uncertain outcomes. A replacement publisher must obey that same contract: `ok` means published, `failed` means definitely unchanged, and `unknown` means the Host cannot determine whether publication happened. Rollback can remove remaining staging; it cannot undo a rename whose acknowledgement was lost. The integration tests exercise an actual rename rejection and uncertainty both before and after a real publication.

There is no `fsync`, journal, crash recovery or promise of durability after process exit, power loss or storage failure. Network filesystems and concurrent external modification are outside this contract. Effects cover one destination and its Script Segment; they do not make unrelated messages or immediate effects atomic. I/O is synchronous and intended for these small examples. Stop and pump every Script using the Host before calling `dispose()`.
