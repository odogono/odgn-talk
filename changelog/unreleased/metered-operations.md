---
type: feat
scope: spec
breaking: true
---
Specify incremental Fuel authorization for Metered Operations, including queued asynchronous read-only charges, replay and accounting. Replace SQLite's specified maximum-row precharge with per-step authorization and a driver callback. Runtime implementation remains deferred (#472, ADR 0082).
