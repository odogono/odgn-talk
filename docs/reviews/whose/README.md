# Whose Clause implementation evidence

Implementation for #547, checked on 2026-10-10 against the specification at
`669b285d280fe112755c4291eda5c2cc5cc52e8d` (merged #548 / ADR 0074).

Both Cores reproduce the new Trace Cases in ordinary and save/restore replay,
and produce identical `whose.dis`.

| Case | Evidence |
| --- | --- |
| [maps](../../../corpus/whose/maps/case.trace) | `every item of orders whose amount > 100 GBP` keeps orders 1 and 3. `the first … whose it's paid is false`, `the last … whose amount > 100 GBP` and `the second … whose price's currency is "GBP"` give ids 2, 3 and 3. |
| [text-chunks](../../../corpus/whose/text-chunks/case.trace) | Lines, words of one line, `delimited by ";"` items and Characters each give a list of texts; `the last word … whose it is not "WARN"` gives `"speed"`. |
| [no-match](../../../corpus/whose/no-match/case.trace) | `[]` for `every`, Nothing for `first` and `last`, `""` for a matching empty line, and `[]` over an empty list, whose condition never runs. |
| [ordinals](../../../corpus/whose/ordinals/case.trace) | `the second item of [4, 2, 0] whose 8 / it > 1` gives 2 and stops before the 0; `third` and `tenth` count matches; `the last …` tests every chunk and raises `division by zero` at the `/` (8:44). |
| [wrong-kind](../../../corpus/whose/wrong-kind/case.trace) | A number condition raises `wrong kind` at `whose` (5:28) and is caught; a missing key reads Nothing; `n > 0` on text raises `can't compare` in the Run (13:50). |
| [keys](../../../corpus/whose/keys/case.trace) | With locals `amount` 4, `length` 100 and `limit` 6, `whose amount > limit` gives `[{amount: 9 …}]`, `whose amount > amount` compares each key with the local, `whose length > 3` reads the text's length, `whose (limit) > 1` keeps all, and `whose it's amount < amount` gives amount 1. `whose amount's currency is "GBP"` reads on with `'s` beside a local `currency`. |
| [not-in-a-whose](../../../corpus/whose/not-in-a-whose/case.trace) | A Script function call (6:32), a call through a local that shadows `abs` (3:36) and a Lambda's `given` (2:33) are `not in a whose`; a later `region` is `unknown name` (2:47). |
| [Disassembly](../../../corpus/disassembly/whose/whose.dis) | Every, first, last, third and tenth matches; a delimited walk over a value and over `line 2 of report`, keeping the chunk read's delimiter temp; code points; a nested clause with its own `it`. The walk's `property` and an ordinal's `const` are at the chunk word, the rest at `whose`. |

Every Heads over lists read `the items of` a list, which the Go Core
raised `wrong kind` for; it now gives the list, as chapter 4 and the TS Core
do ([#565](https://github.com/odogono/odgn-talk/issues/565)). The TS Core's
unchecked delimiter on lists and ranges is left for
[#566](https://github.com/odogono/odgn-talk/issues/566).

Current support is described in the [TS guide](../../../impl/ts/README.md) and
[Go guide](../../../impl/go/README.md). The Go passing gate requires these
cases even while the expectations remain unblessed.

First-blessing approval is separate from execution agreement: the seven
`case.trace` files and `whose.dis` carry `Unblessed` markers until the
maintainer reviews them. No existing corpus expectation was changed.
