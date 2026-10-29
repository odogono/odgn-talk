---
type: feat
scope: tools
---
Add `bun run corpus:cross`, chapter 11's cross-Core replay. It restores every save of each Trace Case on the TS Core and on the Zig reactor, in all four directions, and requires the same Trace, byte-identical saves and equal State Fingerprints. CI runs it on every pull request that touches either Core, the Corpus or the Spec (#1746).
