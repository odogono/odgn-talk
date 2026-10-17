---
type: fix
scope: repo
---
Preserve Function Value names, arities and defining-source documentation in Go Sessions using the experimental Zig adapter, including stale values and repeated Save/Restore, through the opt-in Message Layer feature `function-metadata-v1` (#1093, #1097). Restore also keeps disposed Object state in passive inspection.
