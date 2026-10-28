---
type: feat
scope: repo
---

Write and read the shared save format in the Zig Core (ADR 0144): magic `NTSV`, format version 1, a header and 13 tagged sections, each with its own SHA-256, with Numbers, Quantities, Ranges, Instants, dates and Patterns as structured values. `talk_core_state_fingerprint` reads the State Fingerprint from the header without decoding sections. Save format `zig/1` refuses Zig's own `zig/17` saves with `invalid save`, including under VariablesOnly; drain existing Groups on their old runtime or start fresh Groups. A restored call that a TS Host took with `run` is `not adoptable` (#1723).
