# Zig collecting and List item writes

Measurements for [#924](https://github.com/odogono/odgn-talk/issues/924), against
`8f98a485` (the merged #923 arithmetic changes), on 2026-10-14.

Collecting improves from 0.839 to 0.327 ms (2.57×) and transform from 0.732
to 0.420 ms (1.74×). The standard eight-item update workload improves only
about 2%, close to timing noise; larger retained-List writes improve 5–8%.

## Scope

Collecting and List-literal splices now use the existing immutable spare-capacity
List growth path. Scalar additions can extend the newest span without copying
its earlier elements. Ownership ranks still require a fresh buffer for children
that might introduce a physical ownership cycle, including hidden tails.

In-bounds item writes use `listSet`, removing the scratch whole-List temporary.
Its shared-write branch constructs and measures the final spine once. The root
is borrowed by chunk writes: local bindings, Host arguments, snapshots and
rollback state may still refer to it, so one spine copy remains. Host-owned
input spines are copied into the Group allocator. Padding and range replacement
retain their existing implementation. Ordinary append was already optimized
and is included only as regression coverage.

## Paired results

[Raw paired samples and allocation probes](2026-10-14-zig-list-paths.json). Native Zig 0.17.0, safe mode, C Host `-O2`, Apple M5. Each number is the median of three process medians, each with five timing repeats. Compilation, tests and probes were separate from timings.

| Workload | Before ms | After ms | Speedup |
| --- | ---: | ---: | ---: |
| `core/loop` | 1.355 | 1.403 | 0.97× |
| `core/fib` | 0.955 | 0.942 | 1.01× |
| `core/fib@slice=10` | 4.838 | 4.938 | 0.98× |
| `core/fib@slice=100` | 1.353 | 1.390 | 0.97× |
| `core/fib@slice=1000` | 0.982 | 0.993 | 0.99× |
| `core/fib@slice=10000` | 0.987 | 0.994 | 0.99× |
| `core/calls` | 0.964 | 0.972 | 0.99× |
| `core/lambdas` | 1.325 | 1.308 | 1.01× |
| `numbers/add` | 0.730 | 0.732 | 1.00× |
| `numbers/multiply` | 0.468 | 0.467 | 1.00× |
| `numbers/divide` | 0.492 | 0.503 | 0.98× |
| `numbers/quantity` | 0.495 | 0.500 | 0.99× |
| `text/build` | 0.487 | 0.487 | 1.00× |
| `text/iterate` | 0.794 | 0.791 | 1.00× |
| `text/index` | 1.116 | 1.108 | 1.01× |
| `text/patterns` | 0.685 | 0.681 | 1.01× |
| `text/graphemes` | 1.435 | 1.439 | 1.00× |
| `collections/list-build` | 0.839 | 0.327 | 2.57× |
| `collections/list-append` | 1.422 | 1.438 | 0.99× |
| `collections/map-build` | 1.028 | 1.026 | 1.00× |
| `collections/list-update` | 0.848 | 0.833 | 1.02× |
| `collections/map-update` | 0.305 | 0.303 | 1.01× |
| `collections/iterate` | 2.317 | 2.294 | 1.01× |
| `host/pump` | 0.002 | 0.002 | 1.01× |
| `macro/transform` | 0.732 | 0.420 | 1.74× |
| `macro/report` | 1.278 | 1.282 | 1.00× |
| `macro/game-tick` | 1.831 | 1.833 | 1.00× |
| `messaging/suspend` | 3.233 | 3.240 | 1.00× |
| `lifecycle/load-small` | 0.002 | 0.002 | 1.01× |
| `lifecycle/load-large` | 0.179 | 0.180 | 0.99× |
| `sweep/collect/100` | 0.076 | 0.067 | 1.13× |
| `sweep/update/100` | 0.104 | 0.099 | 1.05× |
| `sweep/collect/300` | 0.322 | 0.191 | 1.68× |
| `sweep/update/300` | 0.562 | 0.533 | 1.05× |
| `sweep/collect/1000` | 2.770 | 0.604 | 4.59× |
| `sweep/update/1000` | 4.899 | 4.585 | 1.07× |
| `sweep/collect/2500` | 17.865 | 1.516 | 11.78× |
| `sweep/update/2500` | 28.685 | 26.485 | 1.08× |

The remaining manifest workloads move by less than 4% in either direction.
Ordinary append, Map work and iteration stay within about 1.2%. These are
advisory machine timings, not performance thresholds; the raw record retains
all samples and the variation between pairs.

## Allocations and scaling

Requested bytes count physical Group allocation requests, not the specified logical allocation. Probes are untimed.

| Workload | Calls before | After | Bytes before | After | Fuel | Logical bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `collections/list-build` | 1,035 | 554 | 1,215,090 | 219,780 | 19,091 | 3,022,112 |
| `collections/list-update` | 1,533 | 1,532 | 110,702 | 109,994 | 28,553 | 24,328 |
| `macro/transform` | 2,437 | 1,874 | 1,101,421 | 385,735 | 20,664 | 6,418,202 |
| `sweep/collect/100` | 233 | 146 | 93,952 | 54,338 | 2,591 | 124,512 |
| `sweep/update/100` | 138 | 138 | 109,213 | 109,213 | 3,343 | 4,136 |
| `sweep/collect/300` | 635 | 350 | 500,689 | 133,555 | 9,591 | 1,093,312 |
| `sweep/update/300` | 341 | 341 | 791,709 | 791,709 | 17,455 | 12,136 |
| `sweep/collect/1000` | 2,037 | 1,056 | 4,450,340 | 415,148 | 53,779 | 12,044,112 |
| `sweep/update/1000` | 1,044 | 1,044 | 8,218,190 | 8,218,190 | 145,099 | 40,136 |
| `sweep/collect/2500` | 5,039 | 2,562 | 26,205,253 | 1,048,133 | 251,591 | 75,110,112 |
| `sweep/update/2500` | 2,546 | 2,546 | 50,487,614 | 50,487,614 | 832,693 | 100,136 |

Scalar collecting grows from 0.067 ms at 100 items to 1.516 ms at 2,500:
22.7× time for 25× the items, versus 236× baseline time. Requested bytes rise
19.3× rather than 279×. This supports amortized linear scalar construction;
logical allocation and Fuel deliberately retain the specified charges. At
2,500 items it is 11.78× faster and requests 96.0% fewer bytes. Rank-forced
copies, older-version branches and nesting are not promised this scaling.

The item-write sweep constructs a List literal of N ones, retains it, then
performs N writes to its first item. It excludes collecting so its results
isolate update scaling, apart from linear initial construction. At 2,500,
the time improves from 28.685 to 26.485 ms, but requested bytes remain
50,487,614: the retained root still requires one copied spine per write.
The temporary lived in reused instruction scratch storage, so removing it
reduces copying without necessarily reducing allocator requests. This remains
quadratic when both length and write count grow. No unique-root mutation or
change to rollback ownership is claimed.

## Residual AppleScript gaps

The fresh [collection comparison](2026-10-14-zig-list-peers.md) and
[transform comparison](2026-10-14-zig-transform-peers.md) run only native Zig,
the TS Core, AppleScript and GopherLua. All outputs pass and Core Fuel agrees.
Zig and peers use three repeats; TS uses mitata's automatic sampling.

| Workload | Zig ms | AppleScript ms | Zig / AppleScript |
| --- | ---: | ---: | ---: |
| List construction | 0.315 | 0.225 | 1.40× |
| List updates | 0.806 | 0.374 | 2.16× |
| Transform | 0.429 | 0.403 | 1.06× |

Construction and transform close much of the issue's original gaps; the
small-List update gap remains essentially unchanged. These fresh peer timings
are separate from the paired native measurements. AppleScript transform is
also slower than in the issue's earlier report, so the changed peer ratio is
not itself a measure of this optimization's speedup. Peers use idiomatic
mutation and native numbers; the remaining ratios include differences in
Value Semantics, Decimal work and dispatch. No other Peer Language performance
runner or WASM performance benchmark was run; WASI was checked for conformance.

## Reproduction

Build each revision with `cd impl/zig && zig build`, then link the same Host:

```sh
cc -std=c11 -O2 -Wall -Wextra -Werror -Iimpl/zig/include \
  bench/zig/host.c impl/zig/zig-out/lib/libtalk.a -o /path/to/host
python3 bench/zig/list-paths.py /path/to/before /path/to/after \
  --before-revision 8f98a485 --pairs 3 --count 5 \
  --out /path/to/list-paths.json
bun run bench --only zig,ts,applescript,gopher-lua --filter collections --count 3 --no-save
bun run bench --only zig,ts,applescript,gopher-lua --filter macro/transform --count 3 --no-save
```

The paired runner alternates binary order. Timings use the default allocator;
separate untimed probes count Group allocation requests during Delivery/Pump,
excluding Load and process-owned Values. Cumulative requested bytes are not live
memory. Group peaks include Load, and the counting allocator has different resize
behavior from the timing allocator. Every sample validates output; every pair
and probe must agree on Fuel and logical allocation. The raw record includes
binary, implementation, workload and harness hashes.

## Validation

- Native `zig build test --summary all`: 220/220 tests and the C Host tests pass.
- `zig build corpus` and `zig build corpus -- --defer-crossings`: 429/429 cases
  pass in each run, including ordinary/restored replay, collecting, chunks,
  snapshots, rollback and limits. No expected records changed.
- Safe wasm32-wasi build and `uv run tools/wasi/zig.py` pass with Wasmtime 49.0.0,
  including physical containment and subsequent healthy Groups.
- TS/Zig fuzz witnesses and mutations pass with identical complete Traces.
- Repository Spec/documentation checks, Unicode and generated Zig/API checks,
  lint, formatting and Zig formatting pass.

New chunk tests retain old and branching shared spans, insert the old List into
itself and through a nested List, verify ownership ranks and logical measures,
and sweep every allocation refusal with the leak-detecting allocator. A separate
allocator test requires Host List replacements to allocate on the Group. The
C Host collecting test raises logical budgets to their conformance minimums so
the physical cap refuses first, checks that the peak stays within the cap and
that teardown returns every Host byte. Existing growth tests cover shared tails,
rank-forced copies, branches and allocation refusal.
