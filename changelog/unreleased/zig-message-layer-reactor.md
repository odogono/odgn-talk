---
type: feat
breaking: true
---
Use the Zig WASI build as the Message Layer reactor, retiring the Go WASI entry point. CI and the C and Elixir harnesses build and check Zig by default; the native Go sidecar remains. Go-reactor saves require their previous runtime or fresh Groups on Zig (ADR 0089, #918).
