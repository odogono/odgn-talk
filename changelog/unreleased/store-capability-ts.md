---
type: feat
scope: ts
---
Implement `store` in the TS Core: `storeCapability`, `add`, a Store engine with key reservations and quotas, and memory, Web Storage and SQLite Stores held to a shared store test kit. The REPL and Playground build in the Session Store, with `:grant … store <name>` and the `:store` Session Commands (ADR 0050, ADR 0062, #226).
