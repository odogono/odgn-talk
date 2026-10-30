---
type: feat
scope: go
---
`CoreVersions()` in the Go embedding reports the embedded reactor's release, such as `zig/0.15.0`, instead of `zig/0.0.0`, and the module now embeds the `reactor-v0.15.0` release byte for byte. `build-artifact.py` records the version, and builds a given `reactor-v*` tag (#1515).
