---
type: feat
breaking: true
---
Every Store kept by one Store implementation shares one Segment Coordinator in both Cores, so a Handler that writes several Stores, or one Store through two aliases, no longer raises `segment participant conflict`: one commit publishes all of its writes, and one rollback discards them (ADR 0069, #461). In TS, `StoreBackend.save` now takes every Store a commit wrote at once, the SQLite Store commits them in one transaction, and a backend may throw `StoreStateUnknownError` to report a commit as `unknown`.
