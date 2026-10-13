---
type: fix
---
Count a Run's pending cleanup in its Persistent State as chapter 8 now defines it in the Zig Core: an Error-mode cleanup keeps its Error's dispatch context and the failed continuation's operands, and a cancellation drops the dispatch contexts it interrupted and keeps only the frames and activations its remaining cleanup needs. A save taken during such cleanup now restores (#629).
