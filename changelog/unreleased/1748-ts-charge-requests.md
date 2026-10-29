---
type: feat
scope: ts
---
The TS Core accepts Operation `metering` declarations and lets a suspending `read-only` call queue `call.requestCharge(fuel)`, settled by the next Pump as accepted, limit or inactive, with the same Trace as the Zig Core. Issued calls keep their eligibility and the request counter across saves, and a pending metered call or unresolved request refuses Save with `effects pending`. Late answers to ended calls are recorded and ignored (#1748).
