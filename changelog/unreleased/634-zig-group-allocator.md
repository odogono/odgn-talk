---
type: feat
---
Give each Group in the Zig Core its own allocator, wrapping one the Host supplies through `talk_group_options`, with a physical cap that turns a runaway allocation into `TALK_OUT_OF_MEMORY` and `talk_group_memory` to read what the Group holds (#634).
