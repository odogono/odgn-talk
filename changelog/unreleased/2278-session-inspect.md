---
type: feat
scope: zig
---
`session-v1` gains `session-inspect`, which gives the session's Group's Inspection and Trace snapshot without recording an input, and `session-complete`, which tells a Driver whether the lines it has collected are a whole Entry yet (#2278).
