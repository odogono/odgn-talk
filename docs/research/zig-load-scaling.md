# Zig load memory and time

Measurements for [#790](https://github.com/odogono/odgn-talk/issues/790), on
2026-10-13, against `b469040a` and that revision with this change. Both builds
use Zig 0.17.0, ReleaseSafe, `wasm32-wasi` and a 1 MiB stack. The Host is
wasmtime-py 49.0.0 on macOS arm64. Times cover `talk_load`, including copying
the source into the instance, but exclude module compilation/instantiation.
Retained bytes are the change in `talk_group_memory.used` after the load.

| Source | Before: time / retained bytes | After: time / retained bytes |
| --- | --- | --- |
| 1,048,576 newlines | 0.043 s / 100,195,204 | 0.044 s / 1,573,684 |
| 100,000 empty Handlers, 2,077,780 source bytes | 81.439 s / 438,448,732 | 0.154 s / 51,405,612 |

The original baseline used a 900 MiB Group cap and a 1 GiB instance cap so it
could complete. The changed build loads both sources with the default 256 MiB
Group cap and a 256 MiB instance cap. For the Handler source it peaks at
182,210,470 Group bytes and 249,561,088 linear-memory bytes. Linear memory
includes allocator capacity and Host buffers; freeing a Group does not shrink
WASM memory.

Doubling the changed build's Handler count from 50,000 to 100,000 raises time
from 0.073 s to 0.154 s and retained memory from 25,624,362 to 51,405,612 bytes.
These times are observations on this Host, not portable latency guarantees.

## Causes

Two searches were quadratic in the Handler count: exporting each Handler
scanned all selectors and earlier exports, and lowering each body scanned the
checker's body list. Export construction now aggregates suspension by Handler
name once and uses a name set; lowering indexes declarations and Lambda
expressions before visiting bodies. Export order, clause aggregation, private
definitions and canonical body numbering stay covered by tests and the corpus.

The Script's code arena also held its syntax tree, checker scopes, lookup
tables, per-body lowering tables and superseded growing buffers. Those aren't
runtime state. Parsing now grows its token/declaration buffers through the
Group allocator and keeps only their final contents in a temporary tree arena.
The checker and lowering have separate temporary arenas; each lowering body's
slot/exit tables are released when that body finishes. Final instruction and
body buffers are allocated at their known sizes. The line index is allocated
at its exact size. The tree is released before copying executable code and
metadata into retained storage. Constant-pool Values keep their independent
ownership, including cleanup on an allocation refusal.

The same storage policy applies to Load, Extend, Reload, Library compilation
and code rebuilt for either restore mode or Library replacement. All temporary
Group allocations still count toward the physical cap.

## Regression checks

- `zig build test` includes retained-memory bounds for newlines, Handlers,
  extensions, Reload and Library compilation. It dispatches the first and last
  Handler after compiler storage has gone. Existing allocation-refusal tests
  exercise cleanup through Load, Extend, Reload and Library replacement. A
  Library compilation check refuses every allocation in turn, including its
  initialiser, and checks that all code and Values are released. Library
  initialiser frames are now cleaned up on a refusal as Script initialiser
  frames already were.
- `zig build corpus -- --check-passing` checks the established disassemblies,
  diagnostics, execution, reload and save/restore cases without changing any
  expected Trace.
- `uv run tools/wasi/zig.py impl/zig/zig-out/bin/talk.wasm` records both large
  sources and the 50,000-Handler sample through `talk.h`. Each uses a fresh
  instance capped at 256 MiB. The check bounds retained bytes and load time,
  executes both ends of the Handler table, releases the Group, and runs another
  Group in the same capped instance.

The Message Layer is still on #635's branch at this base. An isolated probe
applied the Core changes to `fix/issue-635` at `30255b5f`, then used
`tools/wasi/check.py`'s Message Layer Host with the same sources and a 256 MiB
store cap. Both loaded: 0.054 s and 154,009,600 linear-memory bytes for newlines;
0.158 s and 262,864,896 bytes for Handlers. It delivered to `h0` and `h99999`,
checked both completed reports, and made another successful request in the
same instance. This is integration evidence at that branch revision; the
permanent regression at this base runs through `talk.h`.
