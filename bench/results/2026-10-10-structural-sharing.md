# Persistent collection measurements for #598

Measured on 2026-10-10 on Apple M5, macOS arm64, Go 1.27.2 and Bun 1.4.2.
The baseline is `e35980e9`; the candidate is the uncommitted structural-sharing
implementation for [#598](https://github.com/odogono/odgn-talk/issues/598).
Measurements advise implementation choices and do not change the Cost Model.

## Point writes

These workloads keep the original collection reachable and replace different
existing keys/items. Go measures one write through the machine's collection
operations; TS measures 200 writes through `setKey` or `chunkSet` using mitata.
The first logical size is measured before timing in Go; TS includes that first
measurement. All replacements are small Numbers.

Go values are medians of three 100 ms samples. Timing is advisory; the host-byte
reduction and scaling demonstrate the removal of whole-collection copies.

| Go collection | Elements | Before ns/write | After ns/write | Before host bytes/write | After host bytes/write |
| --- | ---: | ---: | ---: | ---: | ---: |
| list | 512 | 16,627.0 | 484.4 | 67,019 | 1,796 |
| map | 512 | 5,314.0 | 332.6 | 27,288 | 850 |
| list | 8,192 | 105,498.0 | 653.4 | 930,651 | 2,091 |
| map | 8,192 | 49,422.0 | 699.0 | 393,240 | 1,232 |

Reproduce the candidate with:

```sh
go -C impl/go test ./internal/machine -run '^$' -bench BenchmarkCollectionPointWrites -benchtime=100ms -count=3
```

For the baseline, copy `collections_bench_test.go` to the same package in a
checkout at `e35980e9` and run the same command.

| TS collection | Elements | Before ms/200 writes | After ms/200 writes |
| --- | ---: | ---: | ---: |
| list | 512 | 0.761 | 0.219 |
| map | 512 | 9.419 | 0.208 |
| list | 8,192 | 9.321 | 0.243 |
| map | 8,192 | 233.468 | 0.243 |

The TS measurement loops 200 times from one retained constructor result, using
item/key `(i * 73) % n` and `num(i)` as replacement. It runs both implementations
in one process, separately for each collection kind and size, and reports the
median mitata sample. A 16-fold larger collection increases candidate write time
only slightly; the baseline grows roughly with collection size.

## Full collection workloads

Go is one 100 ms sample per workload; TS is a mitata median. These small samples
show tradeoffs and are not statistical significance claims.

| Workload | Go before ms | Go after ms | Go before host bytes | Go after host bytes | TS before ms | TS after ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| list-build | 0.912 | 1.044 | 310,385 | 640,391 | 1.435 | 1.571 |
| list-append | 3.901 | 4.505 | 1,298,535 | 2,966,936 | 6.552 | 6.828 |
| map-build | 1.190 | 1.019 | 2,769,628 | 672,559 | 9.898 | 1.562 |
| list-update | 3.009 | 3.052 | 2,433,618 | 2,085,655 | 3.644 | 3.890 |
| map-update | 0.603 | 0.726 | 316,955 | 301,740 | 1.645 | 1.181 |
| iterate | 6.342 | 6.807 | 1,652,004 | 1,658,667 | 9.877 | 8.699 |

TS Map construction is about 84% faster; Go Map construction allocates about 76%
fewer host bytes. Sequential Lists previously used amortized constant-time
buffer growth. Persistent chunk trees make retained-branch growth and point
updates logarithmic, with extra nodes and a modest cost on these sequential
workloads. The update workloads in the suite use only eight starting elements,
so they do not show the large-collection gains above.

```sh
NORTHTALK_BENCH_FILTER=collections go -C bench/go test -run '^$' -bench Run -benchtime=100ms -count=1
bun bench/ts/src/measure-ts.ts collections
```

## Verification

Both full Core suites and corpus gates pass. Collection smoke outputs, Fuel and
logical allocation agree. The shared `collection-edits.talk` fixture has exactly
the same output, 4,409 Fuel and 18,059 bytes of logical allocation at the baseline
and candidate. Tests cover deletion, insertion order, NFC keys, present Nothing,
retained aliases, concurrent branches, rejected charges, and Save/Restore of a
preempted Segment checkpoint. Point-edit tests hold combined List/Map host
allocation below 8 KiB at both 512 and 8,192 elements. The full-size Map-build
allocation ceiling is reduced from 4.2 MB to 1 MB; Fuel and logical allocation
remain pinned.

## Memory backstop

The actual Message Layer passed all eight native and all eight WASI List-growth
cases: default and conformance-minimum limits, Run-local and Script Variable
storage, and repeated text and Nothing. Every case reached its expected Script
fault within **64 MiB + 12 × Allocation Budget**, then ran a healthy Handler.
The largest native peak was 1,241.67 MiB RSS; the largest WASI peak was 1,563 MiB
linear memory, both below the 3,136 MiB conformance-minimum backstop. These are
single-case measurements and the cap is workload-specific guidance.

The [raw record](../../tools/wasi/results/2026-10-10-structural-sharing-memory.json)
contains artifact hashes and every fault, timing and peak. The [Go guide](../../impl/go/README.md#list-memory-and-host-caps)
contains the current table and reproduction commands.
