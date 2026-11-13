---
type: perf
scope: ts
---

Make Runs that roll back while Host Inputs queue up about 1.8× faster, by counting urgent inputs instead of rescanning the queue on every turn.
