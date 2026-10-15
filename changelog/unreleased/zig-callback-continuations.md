---
type: fix
---
Record pending-call abandonment when cancelling a Zig callback, and finish the
active callback and Segment after another Run's Rewind pauses for cleanup
(#962).
