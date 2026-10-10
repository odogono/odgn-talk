---
type: perf
scope: ts
---
Speed up large texts in the TS Core: Fuel's per-scalar charges, save checksums, save decoding and display text. Replaying `limits/persistent-state-minimum` drops from about 4.1s to 0.2s, or from 12s to 2.2s with save/restore between Pumps. The live debugger's frame view is now linear in stack depth. SHA-256 is now correct for inputs of 32 MiB or more.
