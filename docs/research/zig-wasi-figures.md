# The Zig Core's first WASI figures

Answers [ADR 0078](../adr/0078-the-zig-third-core-is-built-though-the-message-layer-meets-its-thresholds.md)'s open consequence, for [#634](https://github.com/odogono/odgn-talk/issues/634): the first Zig build that loads a Script records its Brotli payload and memory per instance against the Go reactor's 2.04 MiB and 15.5 MiB ([the Message Layer measurements](message-layer-measurements.md)).

## Outcome

**The Zig `wasm32-wasi` build is about a fifth of the Go reactor's payload and an eighth of its memory per instance.** Every row is well inside [#532's thresholds](https://github.com/odogono/odgn-talk/issues/532#issuecomment-6095554407), and a CI job now holds the Zig build to them.

| Row | Zig, wasmtime | Go reactor | Threshold |
| --- | --- | --- | --- |
| Memory per instance | **2.00 MiB** (32 pages) | 15.5 MiB (248 pages) | ≤ 16 MiB |
| … with a stdlib import | 3.75 MiB (60 pages) | – | ≤ 16 MiB |
| Payload, Brotli | **0.40 MiB** (418,305 bytes) | 2.04 MiB | ≤ 3 MiB |
| Payload, raw | 1.53 MiB (1,608,384 bytes) | 12.1 MiB | ≤ 25 MiB |
| Payload, gzip -9 | 0.54 MiB (566,088 bytes) | – | – |

ADR 0078 estimated 150 to 300 KB of Brotli payload for a Core without the Go runtime. The build is above that at about 410 KiB. Its data section alone is 376 KB raw: the Unicode tables, the generated catalogues and the stdlib sources. The code section is 1.2 MB.

These figures don't say whether the Zig build should replace the Go reactor behind the Message Layer. ADR 0078 decides that by measuring both with the harnesses in `bench/message-layer-c` and `bench/message-layer/elixir`, and the Zig build has no Message Layer yet. Nor do they cover latency: the Zig Core isn't complete enough to run #532's Capability call and Pump rows like for like.

## Setup

| | |
| --- | --- |
| Commit | `main` at `7dc2628f`, plus this PR |
| Build | `zig build -Dtarget=wasm32-wasi` in `impl/zig`: Zig 0.17.0, `ReleaseSafe` (the Core never builds without safety checks), stripped of debug sections as the Go reactor's `-s -w` is, a 1 MiB stack |
| Runtime | wasmtime 49.0.0 through its Python bindings, Python 3.12.15, Brotli 1.2.0, zlib 1.3.1, in Docker 29.9.0 on `aarch64` Linux |
| Harness | [`tools/wasi/zig.py`](../../tools/wasi/zig.py), which CI runs on every Zig Core change |

The harness drives `talk.h`'s exports directly, since the Zig build has no Message Layer. It packs `talk.h`'s structs into the instance's memory through `talk_alloc`. That export, with `talk_free`, is new in this PR, for any Host in another address space. Memory is taken as the Go reactor's was: linear memory after a Core, a Group, a small Script (`on ping` with an empty body), one Delivery and one Pump. A second figure adds `use padLeft from text`, which compiles that stdlib Library on first use. That compilation was what cost the Go reactor 28 MiB per instance before its #585.

## What it took

- **The stack:** Zig's default 16 MiB stack sits in linear memory, so the first build started at 262 pages, 16.4 MiB, before running anything. Nothing in the Core recurses past its depth guards (128 levels of source and of Value nesting), so the build now sets a 1 MiB stack. The harness checks it holds:
  - It finds the deepest source of each kind that the parser accepts, and loads and runs it: 62 levels of parentheses, 62 of list literals and 125 of nested `if` blocks.
  - It loads source 50 times deeper, which is refused with `TALK_LOAD_REFUSED`.
  - It builds a list nested 120 deep at run time, compares it with itself and stores it.
- **Debug sections:** the unstripped build was 5.8 MB, 4 MB of it DWARF.

The harness also checks containment, as the Go measurements did for runaway Scripts. A Script doubles a text 40 times in a Group with a 1 MiB physical cap: the Pump is refused with `TALK_OUT_OF_MEMORY` at a peak of 913,073 bytes, and the instance then runs a fresh Group.

## Fog

- **Local runtime:** wasmtime-py 49.0.0 can't instantiate any module on the measuring Mac (macOS 27), even a one-function one, so the figures come from Linux in Docker. Pages are 64 KiB on every platform, so the memory figures carry over, and the payload is the same file.
- **Value nesting past 128:** a Script that nests a Value deeper than the Zig Core's 128-level guard gets `TALK_OUT_OF_MEMORY` from the Pump. The spec sets no such limit, so the Script should see an error or a Limit Fault instead. This is a gap in the machine, not in the WASI build, and it doesn't affect these figures.
- **Growth with the Core:** the Zig Core still lacks Capability Scopes, limits, save and restore, and the remaining Standard Capabilities. Each adds code and tables, so the payload will grow before the Core conforms. The CI job holds it to #532's thresholds as it does.
