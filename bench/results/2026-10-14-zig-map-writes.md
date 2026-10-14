# Zig Map write measurements 2026 10 14

Evidence for [#876](https://github.com/odogono/odgn-talk/issues/876), comparing
baseline `b3a8aed696a62a2f7812621f4f1f16fc3a0a4170` with this issue's working-tree
optimization. The [raw measurements](2026-10-14-zig-map-writes.json) preserve
three consecutive before/after pairs, every timing sample, allocation probes,
source hashes and machine/toolchain settings.

On Apple M5, macOS 27.0.1, arm64, Zig 0.17.0 in `safe` mode and a C Host built
with Apple clang 21.0.0 at `-O2`, 300-entry Map construction fell from 7.056 ms
to 1.299 ms, about 5.4× faster. At 3,000 entries it fell from 5.567 s to
89.115 ms, about 62× faster. Fuel and logical allocation stayed identical in
every before/after pair. The language version was 1.0-rc.3 and Cost Model 0.

## Construction scaling

Each cell is the median of three per-process medians, in milliseconds. Each
process takes three samples, each averaging complete Runs over at least 50 ms;
a single slow Run can exceed that window. An untimed Run first checks output.
Baseline and optimized processes alternate, with no other agent-started test,
build or benchmark jobs running during the paired measurements.

| Entries | Before ms | After ms | Speedup | Fuel | Logical allocation bytes |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 0.550 | 0.272 | 2.02× | 4,094 | 8,320 |
| 300 | 7.056 | 1.299 | 5.43× | 14,094 | 24,920 |
| 1,000 | 215.553 | 9.658 | 22.32× | 68,782 | 83,021 |
| 3,000 | 5,567.322 | 89.115 | 62.47× | 393,782 | 251,021 |

All three pairs improved. At 300 entries the baseline medians span
5.768–7.769 ms and optimized medians 1.067–1.317 ms. At 3,000 entries they span
4.577–5.583 s and 73.343–90.747 ms. These spans are wider than an earlier
measurement of the same change, which gave a similar 5.4× and 65×, so the
machine was busier; the ratios held. The 1,000-to-3,000 increase takes about
25.8× as long before and 9.2× after, consistent with removing the cubic
construction work from repeated duplicate scans while retaining quadratic
copying. Timing remains advisory.

## Physical allocation probes

Each probe is a separate untimed Run with a counting Host allocator. Requested
bytes are cumulative Group allocations during Delivery/Pump, excluding Load;
frees do not subtract. Host arguments, returned display bytes and other
process-owned allocations are outside the probe. The counting allocator uses
`posix_memalign` and has different resizing behavior from Zig's default
allocator, so these are request counts, not resident-memory measurements.
The Group peak includes Load. Every pair reproduced the same probe figures.

| Entries | Requested bytes before | Requested bytes after | Allocation calls before | Allocation calls after |
| ---: | ---: | ---: | ---: | ---: |
| 100 | 935,905 | 361,313 | 8,796 | 8,177 |
| 300 | 7,008,058 | 1,858,378 | 56,971 | 54,478 |
| 1,000 | 75,439,600 | 15,604,040 | 542,560 | 531,529 |
| 3,000 | 687,579,537 | 129,812,169 | 4,635,537 | 4,594,530 |

At 3,000 entries, requested bytes fall by 81.1%, while allocation calls fall
by only 0.9%: copying every existing key still makes many small allocations.
Group peak falls from 1,479,467 to 1,396,823 bytes, about 5.6%. Both versions
stay under the Host's unchanged 256 MiB physical cap and per-Run logical
allocation budget, with a 1,000,000,000 Fuel budget.

## Map updates and macro workloads

Five samples per process use the same 50 ms minimum window. These figures
are medians of three per-process medians; each process validates its expected
output and pins every timed Run's Fuel and logical allocation.

| Workload | Before ms | After ms | Before Fuel | Before logical allocation bytes |
| --- | ---: | ---: | ---: | ---: |
| `collections/map-update` | 0.430 | 0.358 | 8,056 | 12,432 |
| `macro/transform` | 1.474 | 1.489 | 20,664 | 6,418,202 |
| `macro/report` | 1.631 | 1.569 | 86,555 | 1,291,900 |
| `macro/game-tick` | 3.620 | 3.438 | 67,042 | 80,270 |

Map updates run about 1.20× faster. Macro transform is effectively unchanged
(about 1% slower by the median, within the spread); report and game-tick show small improvements.
No material macro regression appears in these pairs. Fuel and logical allocation
are identical after the optimization for all four workloads.

## Profiles and storage choice

Two-second native `sample` profiles at 3,000 entries, taken before a
refactor that left the timings and probes unchanged, support the source-level
hypothesis. Before, 1,419 of 1,473 Pump samples sit in the general `map`
constructor's duplicate scan, including 1,262 under `mem.eqlBytes`. After,
the general constructor disappears from the construction hot path: 78 of
1,476 Pump samples are in the update's single key search. Allocation/free,
key copying and safe-mode memory initialization now account for much of the
remaining sampled work. Samples describe these Runs, not universal CPU shares.

The private update copies the existing ordered entries and their key bytes,
validating/normalizing only the incoming key. It computes depth and ownership
rank from the resulting children and commits the new root only after every
allocation succeeds. External construction retains full UTF-8/NFC and duplicate
validation. Neither the Map representation nor the Cost Model changes.

Shared key/entry storage is the stronger next candidate than an index alone:
the remaining construction has roughly quadratic copying and nearly unchanged
allocation counts, while the linear key search occupies only about 5% of the
after profile. An insertion-order-preserving index would help lookup but leave
key/entry copying and teardown. Shared storage needs ownership rules for retained
versions, self-insertion and allocator provenance, plus physical-cap measurements.
This change isolates validation removal; it keeps Maps as independently owned
ordered arrays rather than combining it with a storage redesign.

The related comparison Fuel work (#869), Value-depth work (#871), and Mappings
(#697) remain separate. The existing 128-level Value guard and equality/Fuel
behavior are preserved; this change does not claim their acceptance criteria.

## Reproduction and validation

Build each Core revision in its own checkout with `zig build` in `impl/zig`.
Compile the same updated Host against each revision's `talk.h` and library:

```sh
cc -std=c11 -O2 -Wall -Wextra -Werror -Iimpl/zig/include \
  bench/zig/host.c impl/zig/zig-out/lib/libtalk.a -o .cache/bench-zig/host
python3 bench/zig/map-scaling.py .cache/bench-zig/host --count 3
```

Run the baseline sweep then the optimized sweep, repeating three times. For
Map updates and each macro workload, use the same Host with the manifest's
source, N and expected output, slice `0`, count `5` and smoke `0`. Ordinary
suite timings remain available through `bun run bench --only zig`.
Profiles use `sample <host-pid> 2 1 -file <profile.txt>` while that Host runs
`collections/map-build` at 3,000 entries; profiling is separate from timing.

Validation on the optimized checkout:

- `zig build test --summary all`: 162 Zig tests and the native C Host tests pass.
  Focused tests cover normalized replacement, external NFC duplicates, insertion
  order, retained originals, nested/self-insertion, depth/rank preservation,
  atomic allocator refusal, Group physical caps, Save/Restore and Segment rollback.
- `zig build corpus`: all 418 cases pass, including eligible restored replay.
  Existing blessed expectations are unchanged.
- Safe WASI build and `uv run tools/wasi/zig.py .cache/zig-wasi/bin/talk.wasm`:
  pass, including normalized Map replacement/self-insertion and a Map construction
  refusal under a 64 KiB Group cap, followed by a healthy fresh Group.
- `bun run bench --filter collections/map --smoke`: all Cores and available peers
  pass; Fuel agrees between the Cores. Smoke timings are not used above.
- Zig fuzz witnesses/mutations, Unicode/generated/API checks, Zig formatting,
  repository Spec/docs checks, lint and formatting checks pass.
