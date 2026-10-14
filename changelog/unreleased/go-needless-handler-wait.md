---
type: fix
---
Reject needless `and wait` on non-suspending Handler calls in the Go Core,
including inherited Handlers and names shared with Script Variables or Constants (#833).
