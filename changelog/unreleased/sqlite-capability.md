---
type: feat
scope: spec
---
Specify `sqlite`, an optional Standard Capability that runs raw SQL with bound parameters against a database the Host keeps. Its writes and transactions commit or roll back with the Segment, and a Store kept in the same database shares its Segment Coordinator. Error codes may now contain hyphenated words, as in `not read-only` (ADR 0070).
