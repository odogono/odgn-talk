# Tell block implementation evidence

Implementation for #337, checked on 2026-10-07 against the specification at
`1ba7a8bfe08796bbf339c6d214f47b57d80e232f` (merged #420 / ADR 0063).

Both Cores reproduce the four new Trace Cases in ordinary and save/restore
replay, and produce identical `draw.dis`.

| Case | Evidence |
| --- | --- |
| [equivalent](../../../corpus/tell-block/equivalent/case.trace) | `oneline` and `block` make the same immediate, fire-and-forget and suspending calls with the same Fuel, allocation and Persistent State. The `note` line reads the `it` the `price` line left. A failing `price` line raises at `price` (7:5), where the one-line call raises at `ask` (6:3). |
| [join](../../../corpus/tell-block/join/case.trace) | Two waiting lines in a Join's body are both members, started before the Join suspends, and `it` is their answers in order. |
| [load-checks](../../../corpus/tell-block/load-checks/case.trace) | A mismatched `and wait` on an immediate, suspending or fire-and-forget line is `wrong mode` at the Operation name. An undeclared Operation is `unknown operation` at its name, and a block whose Grant isn't held reports one `unknown operation` at its receiver for two lines. |
| [library](../../../corpus/tell-block/library/case.trace) | A Library's fire-and-forget lines are compiled as `tell`. A Script that grants `log` as `hush`, whose `write` is immediate, gets `wrong mode` at its `use` line for each of the Library's calls. |
| [Disassembly](../../../corpus/disassembly/tell-block/draw.dis) | `block` emits `oneline`'s instructions, with each line's at its Operation name, and a Join's waiting lines are `join-ask`. |

The Disassembly Case's harness links declarations only, so its lines lower as
`ask`. Its Operations are all immediate or suspending, for which loading
chooses `ask` too; the `equivalent` Trace pins the fire-and-forget line.

Current support is described in the [TS guide](../../../impl/ts/README.md) and
[Go guide](../../../impl/go/README.md). The Go passing gate requires these
cases even while the expectations remain unblessed.

First-blessing approval is separate from execution agreement: the four
`case.trace` files and `draw.dis` carry `Unblessed` markers until the
maintainer reviews them. No existing corpus expectation was changed.
