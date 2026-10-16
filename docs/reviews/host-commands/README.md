# Host Commands implementation evidence

Implementation for #1019, checked on 2026-10-16 against the specification at
`3dda179883d80ab5cc2c1dc773062214f37c6fab` (merged #1034 / ADR 0094).

The cases were blessed by agreement with `bun run corpus:bless`: the TS, Go
and Zig Cores give the same expectations, in ordinary and save/restore replay.

| Case | Evidence |
| --- | --- |
| [host-commands](../../../corpus/capabilities/host-commands/case.trace) | `oneline` and `command` make the same calls with the same Fuel, allocation and Persistent State: `price` leaves 2 in `it`, `note` leaves it unchanged, and `fetch … and wait` ends its Segment `ask-wait`. A failing `price` raises at 6:3 in both, and neither Run makes its `note` call. |
| [host-commands-shadowing](../../../corpus/capabilities/host-commands-shadowing/case.trace) | The knight's own `price` Handler takes the call, with no `call` record. `note "moved"` is a `call`, and the board's `note` Handler never runs. `note "moved" to "rook"` is a `send` of `note:to:` that the board handles. |
| [host-commands-load-checks](../../../corpus/capabilities/host-commands-load-checks/case.trace) | `wrong mode` at the command's name for `and wait` on immediate and fire-and-forget Operations and its absence on a suspending one, then `wrong argument count` and `wrong argument`. Two Grants offering `price` are `name clash` at the call (5:3), `use price from prices` is `name clash` at `price` (3:5), and `use cost from prices as price` is `name clash` at the new name (3:25). |
| [host-commands-library](../../../corpus/capabilities/host-commands-library/case.trace) | A Library's Host Commands are called through an importer that holds `till`; `bare` gets `missing grant` at its `use` line once for each needed Operation. |
| [host-commands-grants-as-used](../../../corpus/capabilities/host-commands-grants-as-used/case.trace) | `price`, called only as a Host Command, keeps its Operation; `till.note` and the unused `clock` Grant are trimmed, so Extend reports `unknown operation` for both. |

Choices the Spec leaves open, made here for the other Cores to follow:

- **Two Grants offering one command** is a `name clash` at each call that would
  resolve to it, not when the Script loads without calling it, since the load
  error needs a source position. A Handler of the Script with that Selector
  takes the call, so it reports nothing.
- **An Import named like a Host Command** is a `name clash` at its name in the
  `use` line, whether or not it is called, as an Import named like a Handler
  is. A renamed Import clashes at its new name, after `as`.
- **`and wait` in a Join or a Timeout Block** on a Host Command stays `not in a
  join` and `not in a timeout`, as for any Command Call, rather than becoming a
  Join Member or a bounded wait.
- **The Fingerprint** writes `command` after `segmentBound`, only as `true`.

`DefineCapability`'s refusal of `command` on a Reserved Word can't be written as
a Trace Case, since the runner defines Capabilities before any record; the TS
unit tests cover it.

First-blessing approval is separate from execution agreement: the five
`case.trace` files carry `Unblessed` markers until the maintainer reviews them.
No existing corpus expectation was changed.
