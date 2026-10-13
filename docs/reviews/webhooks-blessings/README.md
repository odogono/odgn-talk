# Bun webhook rules Example Host expectation approval

On 2026-10-13, the maintainer reviewed and accepted the case below in the #144
conversation, after [PR #616](https://github.com/odogono/odgn-talk/pull/616)
merged.

## Approved case

- `examples/webhooks`

Only the `Unblessed` comment header changes in this expectation, and the
recorder no longer writes it. Host Inputs, Stubs, Core output records, source
positions, code identities, Fuel and allocation stay byte for byte as PR #616
recorded them.

## Evidence and boundaries

The [Bun webhook rules Example Host](../../../impl/ts/examples/webhooks/README.md)
recorded the Trace with a manual Clock and a stand-in upstream, writing its
immediate Host functions' answers as `stub` lines. `bun run corpus:bless
examples/webhooks` then wrote a byte-identical expectation, with the TS and Go
runners agreeing in ordinary and save/restore replay. The first Go replay
diverged at an aborted fetch's late failure; that became #614, with a minimized
case and the Go fix in #615. The case is in the Go passing gate, and
`webhooks.test.ts` fails if a fresh recording differs.

The expectation review follows
[chapter 11](../../../spec/11-the-trace-and-conformance.md#bless).
