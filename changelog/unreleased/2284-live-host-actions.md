---
type: feat
scope: zig
---
The Zig Session Host performs all fourteen Host actions a live embedder hands it, records each with its reply, and checks the reply when it replays a Transcript; `session-v1` carries them between Host calls and inside a crossing's answer (#2284).
