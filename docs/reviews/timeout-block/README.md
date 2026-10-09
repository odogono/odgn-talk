# Timeout Block implementation evidence

Implementation for #542, checked on 2026-10-09 against the specification at
`5886c4efb431e0b9e43ea49832cb51e8f64fdb72` (merged #543 / ADR 0073).

Both Cores reproduce the new Trace Cases in ordinary and save/restore replay,
and produce identical `poll.dis`.

| Case | Evidence |
| --- | --- |
| [timeout-block-join](../../../corpus/suspension/timeout-block-join/case.trace) | d1's 2 s block runs out at 09:00:02 with its second fetch pending: `raise` at the Join's closing `end` (13:7), then `abandon board/r1.c3`, and `e` is `{code: "timeout", after: 2000 ms, deadline: true, …}` with no `index`. The late answer is a `note`. d2's Join answers first, so its deadline never fires; its `seg` shows `until` at the block's deadline. |
| [timeout-block-waits](../../../corpus/suspension/timeout-block-waits/case.trace) | `nested`: an inner 10 s block inside a 1 s one raises `after: 1000 ms`. `tie`: `wait for ready or 1 s` in a 1 s block raises rather than leaving Nothing. `again`: an `ask … and wait` ended by the block carries `capability` and `operation` before `deadline`, then `wait 0 s` after the deadline raises in the same Segment. `inner`: after an inner block's deadline, the outer one bounds the later `wait 2 s` and `send … and wait` (`until` 09:00:10). `slow`: the receiver of an abandoned `send … and wait` runs on and its reply is dropped. |
| [not-in-a-timeout](../../../corpus/load-diagnostics/not-in-a-timeout/case.trace) | `blink and wait` and `f(1) and wait` in a block are `not in a timeout` at 7:5 and 8:5; `send blink to me and wait` loads. |
| [empty-timeout](../../../corpus/load-diagnostics/empty-timeout/case.trace) | A block whose only wait is in a Lambda, and a block in a Join's body, are `empty timeout` at their `with`. |
| [Disassembly](../../../corpus/disassembly/timeout-block/poll.dis) | `timeout-start` and `timeout-end` around each body; the catch around the inner block has depth 2; `exit repeat` pops the inner deadline at its own position before the `finally` copy; `next repeat` from a catch inside the outer block pops nothing; `return` leaves the deadline with the frame. |

Current support is described in the [TS guide](../../../impl/ts/README.md) and
[Go guide](../../../impl/go/README.md). The Go passing gate requires these
cases even while the expectations remain unblessed.

First-blessing approval is separate from execution agreement: the four
`case.trace` files and `poll.dis` carry `Unblessed` markers until the
maintainer reviews them. No existing corpus expectation was changed.
