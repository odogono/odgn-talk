# Go Save and Restore optimization (#504)

Measured on 2026-10-10, darwin/arm64, Apple M5, Go 1.27.2.
The baseline is commit `0701253ab0e036b1b8cf639a9cb5fd7b7665a105`;
the optimized measurements are the #504 working tree based on that commit.
These are the full-size `lifecycle/restore` workload (500 rows), measured without
profiling or other test runs active. Timing remains advisory.

```sh
NORTHTALK_BENCH_FILTER=lifecycle/restore go -C bench/go test \
  -run '^$' -bench 'Run$' -benchmem -count=3 -benchtime=1s
# Optimized run: the same command with -count=5.
```

| Median metric            |     Before |      After |       Change |
| ------------------------ | ---------: | ---------: | -----------: |
| Run                      |  56.443 ms |  17.932 ms | 3.15× faster |
| Host bytes per Run       | 66,012,551 | 16,846,574 |  74.5% fewer |
| Host allocations per Run |    493,723 |    203,791 |  58.7% fewer |
| Fuel                     |      8,015 |      8,015 |    unchanged |
| Logical allocation       |      8,024 |      8,024 |    unchanged |

Before samples (ns/op, B/op, allocs/op):

```text
56716529  65966783  493723
55357798  66012551  493577
56443285  66034461  493886
```

After samples:

```text
17856152  16846574  203824
18204860  16842676  203785
18328277  16849264  203731
17736426  16845368  203791
17931618  16846909  203822
```

## What changed

The Codec writes snapshot JSON into a byte buffer and reads tokens directly
into snapshot fields. Cached struct layouts preserve the old exported field
names and lexical ordering, ignoring JSON tags as before. Bytes remain numeric
arrays; nil and empty collections, integer bounds, string escaping, references,
and Value validation retain their old rules. Invalid or noncanonical input
that fails the streaming path is normalized using the old JSON rules before a
retry, preserving duplicate-member and reference behavior.

Save encodes once unless it discovers stale Function Homes that require the
Stale table to be added in a second pass. It quotes the payload directly into an
exactly sized checksum envelope. Restore reuses one payload byte slice for its
checksum, header, and graph. Checking inactive Value fields no longer boxes two
large structs for each Value. The save format version is unchanged.

## Verification

- The old graph Codec is retained only as a test oracle, comparing exact bytes,
  decoded data and malformed-input acceptance. The pre-compaction go/6 fixture
  still round trips byte for byte, and the envelope matches its old encoder.
- Value and string differential fuzzing passed; the duplicate-member case it
  discovered is retained as a regression seed.
- `go -C impl/go test ./...`, `go -C impl/go test -race ./...`,
  `go -C impl/go vet ./...`, and `bun run check` passed.
- `go -C impl/go run ./cmd/corpus --check-passing` passed all 377 cases,
  including Save/Restore replays.
- The seed-1 dual-Core fuzz smoke completed 64 cases with no findings, including
  828 Save/Restore pairs.
- Go benchmark smoke/repeat tests and allocation ceilings passed. The full-size
  Restore workload now has a 20 MB Host allocation ceiling with output, Fuel,
  and logical allocation pinned; the baseline failed this ceiling at 65.8 MB.
