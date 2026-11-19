---
type: feat
scope: zig
breaking: true
---

Give every Zig load diagnostic and syntax error an end position, the exclusive end of the token it is reported at, in `talk_diagnostic`'s `end_line`/`end_col`, the `load error` and `analyze-*` replies' `endLine`/`endCol`, and the Trace's `diag … end=`. `talk_diagnostic` grows, so a C Host built against an earlier `talk.h` must be rebuilt.
