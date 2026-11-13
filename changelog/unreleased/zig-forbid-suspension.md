---
type: feat
scope: zig
---

The Zig Core, its C API, the Go embedding and the Elixir package take `forbidSuspension` at Load, so a Host can refuse any Script that could suspend, through Reload, Extend, Library replacement and restore.
