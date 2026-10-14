---
type: fix
---
The Zig Core counts a Run cancelled by a `replacing` Handler as its cancellation keeps it while that waits to run: only the frames and operand prefixes its `finally` blocks need, as the TS and Go Cores do. It had counted every frame, overstating the next Segment's Persistent State (#636).
