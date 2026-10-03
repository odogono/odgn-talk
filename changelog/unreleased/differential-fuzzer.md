---
type: feat
scope: tools
---
Add the differential fuzzer. It generates Scripts and Host Inputs, checks the TS
Core's Traces against conformance oracles, and minimizes what it finds. Run
`bun run fuzz smoke`, or `bun run fuzz reproduce <case.json>` for a nightly finding.
