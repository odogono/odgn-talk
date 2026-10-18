# Zig Wait table — 2026-10-18

For [#1220](https://github.com/odogono/odgn-talk/issues/1220), move ordered
Wait storage, timer order, Call/reply lookup, due selection and Run/Join Member
back-references, and Call abandonment, into
[`waits.zig`](../../impl/zig/src/machine/waits.zig). The Group keeps
scheduling and Trace writes. The table
retains the same ArrayList, ordered removal and deadline/order comparison.
The save codec retains its layout and restores references through the table.

## Paired benchmarks

The [raw measurements](2026-10-18-zig-wait-table.json) compare `c2916a18`
with this refactor on an Apple M5, macOS 27.0.1, Zig 0.17.0 native `safe`,
and the same `talk.h` benchmark Host compiled with `zig cc -O2`.
Executable and source hashes identify both builds. The results cover all
30 supported manifest variants plus six additional slice/protected-loop
variants: 36 variants, three alternating process pairs each, three timing
samples per process. Each sample averages Runs over at least 50 ms.
Counting-allocator probes run in separate processes; output, Fuel and logical
allocation must agree. No CPU profiling was enabled.

Median paired Run changes range from -3.65% to +1.30%, with a median of
-1.48% across variants. The Wait-using `messaging/suspend` workload changes
+0.93% (individual pairs +1.12%, +0.93%, +0.79%); `host/pump` changes
-2.83%. There is no material regression in these measurements. These are
shared-machine timings, not evidence of a general speedup. One
`collections/list-update` pair has a +75.31% outlier; the other two pairs
are -2.22% and -1.89%.

Outputs, Fuel, logical allocation and every recorded Group/Host allocation
counter agree across all 108 paired measurements. The initial three-sample
baseline was captured before editing; the recorded comparison reruns the
preserved baseline binary adjacent to the after binary.

Build `bench/zig/host.c` against each revision's native `libtalk.a`, then run:

```sh
python3 bench/zig/instruction-bookkeeping.py /path/to/before-host /path/to/after-host \
  --before-revision c2916a18 --pairs 3 --count 3 \
  --source-file impl/zig/src/machine/waits.zig \
  --source-file impl/zig/src/machine/snapshot.zig \
  --out /path/to/results.json
```

## Trace and save equivalence

The dedicated [`wait-table.c`](../zig/wait-table.c) Host checks ordinary
Waits, event observation, Joins bounded by Timeout Blocks, preempted Joins,
replies, equal deadlines, and stopping suspended Runs. It delivers two Runs
per scenario and saves after four Pumps. Linked separately against the
baseline and after libraries, it produces identical 5,720-byte Traces and
16 byte-identical saves (244–1,612 bytes). Their hashes are recorded under
`waitTableEquivalence` in the JSON.

Compile each lane and compare its Trace and corresponding save files:

```sh
zig cc -std=c11 -O2 -Wall -Wextra -Werror -Iimpl/zig/include \
  bench/zig/wait-table.c /path/to/libtalk.a -o /path/to/wait-table
/path/to/wait-table /path/to/save-prefix > /path/to/trace
```

The preempted-Join scenario finishes with an unlimited Pump. Sending Stop
at that preempted state instead crashes both baseline and after binaries;
this existing behavior is outside the refactor and needs a separate fix.
To reproduce, remove the `scenario != 3` guard around `talk_script_stop`
in the probe Host and run either lane.

## Integration checks

`zig build test` passes, including the C Host tests and six new bare-Run
Wait table tests. Existing test expectations are unchanged; their internal
Group table access uses `g.waits.items()` instead of `g.pending.items`.
All 445 Corpus cases pass both normally and with `--defer-crossings`.
`zig fmt --check impl/zig`, the C API declaration check and the Markdown
link check pass. No Corpus expectations, save version or C declarations change.
