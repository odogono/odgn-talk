# Multi-tenant Example Host expectation approval

On 2026-10-10, the maintainer approved the two cases below in the #143
conversation, “the traces look fine”, and merged
[PR #610](https://github.com/odogono/odgn-talk/pull/610).

## Approved cases

- `examples/tenants-acme`
- `examples/tenants-globex`

Only the `Unblessed` comment header changes in these expectations, and the
recorder no longer writes it. Host Inputs, Stubs, Core output records, source
positions, code identities, Fuel and allocation stay byte for byte as PR #610
recorded them.

## Evidence and boundaries

The [multi-tenant Go Example Host](../../../impl/go/examples/tenants/README.md)
recorded each Trace from its live Groups, writing its Host functions' answers
and Charges as `stub` lines. `bun run corpus:bless` then wrote byte-identical
expectations, with the TS and Go runners agreeing in ordinary and save/restore
replay. Both cases are in the Go passing gate, and
`TestRecordedCasesMatchCorpus` fails if a fresh recording differs.

The expectation review follows
[chapter 11](../../../spec/11-the-trace-and-conformance.md#bless).
