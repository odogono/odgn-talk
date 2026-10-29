---
type: feat
scope: spec
breaking: true
---
SQLite charges `perStep` Fuel before every statement step instead of `max × perRow` up front. `sqliteCapability(impl, costs, perStep)` in TS and `Core.SqliteCapability(impl, costs, perStep)` in Go pass `query` and `change` a `beforeStep` callback, which every `SqliteImpl` must call once immediately before each step, the completion check and the probe past `max` included, propagating its refusal without stepping; the `node:sqlite` and Go drivers do. `query` is metered `read-only` and `change` `segment-bound`, so a refused step writes `charge-refused=yes`. Corpus setup takes `perStep`, and `perRow` is refused (#1795).
