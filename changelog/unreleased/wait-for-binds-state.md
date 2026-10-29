---
type: fix
scope: repo
---

Measure a fired `wait for`'s bound names the same way in both Cores. A fired `wait for` now writes its bound values into the frame at once, and the event its ready Run retains counts only its message. The TS Core used to count a re-bound name's earlier value as well, and the Zig Core added 8 per bound name. Persistent State drops by those amounts while the Run is ready.
