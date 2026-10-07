# Store expectation approval

On 2026-10-07, the maintainer explicitly approved the four cases below in the
#226 conversation: “have reviewed the store traces - they look good to me”.

## Approved cases

- `capabilities/standard-store`
- `capabilities/standard-store-validation`
- `capabilities/standard-store-errors`
- `capabilities/standard-store-segments`

Only the `Unblessed` comment header changes in these expectations. Host Inputs,
Core output records, source positions, code identities, Fuel and allocation
stay byte for byte as [PR #402](https://github.com/odogono/odgn-talk/pull/402)
produced them. Removing the markers puts these cases in the TS runner's default
selection.

## Evidence and boundaries

At this approval on 2026-10-07, the TS Core from PR #402 produced each Trace,
and the TS runner checked it in Save/Restore replay. The Go Core did not
implement `store`, so its runner deferred these cases and they were outside
its passing gate. Current support and limitations are described in the
[TS Group and Trace Cases guide](../../../impl/ts/README.md#the-group-and-trace-cases)
and the [Go Store guide](../../../impl/go/README.md#store-standard-capability).
This approval covers the Core's side of `store` only;
the Store semantics behind each Stub are held to the
[store test kit](../../../corpus/store-kit/) instead.

The expectation review follows
[chapter 11](../../../spec/11-the-trace-and-conformance.md#bless).
