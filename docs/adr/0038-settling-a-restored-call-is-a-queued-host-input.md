# Settling a restored call is a queued Host Input

`Group.Settle` is a queued call, like `Answer` and `Fail`, not a worker call. It is safe from any goroutine, it appends to the input queue and returns at once, and the first Pump after the restore drains each settlement in the order it was made. Misuse is known at the call: a call id that isn't pending, one already settled, or a `Settle` made once the first Pump has started, is the Host error `unknown call`, and nothing is queued. `Settle` still returns the new `Call` for an adopted call at once. We chose this because a settlement already behaves like an answer. It is recorded when the first Pump drains it, and a reissue runs `Start` there, reading that Pump's Clock. Chapter 9 listing `Settle` as a worker call was the one place that said otherwise, and it contradicted how chapters 10 and 11 record it. Settled while writing the seed cases (#114).

## Considered Options

- **A worker call that acts at once:** a reissue's `Start` would run outside any Pump, with no Clock reading for `Call.Now()`, and a settlement would need a Trace position of its own, apart from the other Host Inputs.
- **A worker call that queues:** it would behave the same, but callable only from the pumping goroutine. That rules out a Host settling from the code that still holds each call's work, for no gain.

## Consequences

- **Narrows ADR 0015:** its list of worker calls under **Reentry** no longer includes `Settle`, so a `Settle` from inside a Pump is `unknown call`, not `reentrant call`.
- **The Trace** is unchanged. A `settle` line is written just before the first Pump's `pump` line, and one refused at the call is written there, with a `refused` record ([chapter 11](../../spec/11-the-trace-and-conformance.md)).
- **Spec:** chapter 9 moves `Settle` to the queued calls, chapter 10 says it is queued and when its misuse is known, and `talk.go` and `talk.ts` follow.
