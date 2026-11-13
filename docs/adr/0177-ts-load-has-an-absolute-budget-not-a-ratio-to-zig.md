# TS Load has an absolute budget, not a ratio to Zig

[ADR 0132](0132-ts-load-targets-10x-zig-without-a-single-pass-front-end.md) set TS Load within 10× of the Zig Core. [#2224](https://github.com/odogono/odgn-talk/issues/2224) reported TS Load past that target, at 10.3–10.5×. Most of the drift came from the Zig Core getting faster: Zig's `lifecycle/load-small` fell from 5.7 µs to 3.1 µs while TS stayed where it was. A ratio to Zig makes TS miss or meet its target as a side effect of Zig's progress. It says nothing about what a TS user waits for.

The TS Load target is therefore an absolute budget, measured with Bun on an Apple M5 with alternating `--count 5` runs, as ADR 0132 measures:

| Benchmark              | Budget |
| ---------------------- | -----: |
| `lifecycle/load-large` |   8 ms |
| `lifecycle/load-small` |  30 µs |

`load-large` stands for a large Script's throughput. `load-small` stands for the fixed cost of each Load, which the LSP and Folio pay on every edit. The `macro/*` Scripts sit between the two and have no budget of their own. Each budget is about 15% above the median on `main` when this was decided, enough to absorb bench noise of ±5–8% but not a real regression. A budget is not loosened to fit a regression. A regression is fixed or recorded with its reason.

Node stays a spot-check. A Node figure more than about 1.5× the Bun budget is worth an issue but is not a breach. TS ÷ Zig is still reported in bench write-ups as context, with no target attached.

Nothing enforces the budget. Shared CI runners can't time an absolute figure reliably, so the budget is checked by hand when a change touches Load, the way ADR 0132's target was.

This replaces only ADR 0132's target. ADR 0132's conclusion that a single-pass or incremental front end stays out of scope for Load stands, and so do the Run target and the constraints from [#1579](https://github.com/odogono/odgn-talk/issues/1579).

## Considered options

- **Keep the 10× ratio and record the drift.** Rejected, because the next speed-up in the Zig Core would reopen the question with no change to TS.
- **Pin the ratio to a frozen Zig release.** Rejected: that is an absolute budget in a roundabout form, and it needs an old reactor built to check it.
- **Spend on the parser to get back under 10×.** Not needed, and the per-token items are unlikely to reach 5×. They are tracked as cheap wins in [#2229](https://github.com/odogono/odgn-talk/issues/2229), not as target work.

## Consequences

Re-measuring for this decision on `main` at `2e708ed8`, on a moderately loaded machine, gave `load-large` 6.87 ms and `load-small` 26.3 µs on Bun, and 6.5–8.5× of Zig across `lifecycle/load-*` and `macro/*` on both runtimes. ADR 0132's target was not breached under its own protocol. #2224's figures came from a `--count 3` run and were about 20% slower. Small-Script Load on Bun is about 35% slower than ADR 0132's idle recheck of 18.5–19.3 µs, with no matching change on Node or Zig. [#2230](https://github.com/odogono/odgn-talk/issues/2230) re-measures it idle and finds the cause, and the `load-small` budget is confirmed from its idle figure.
