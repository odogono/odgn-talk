---
type: feat
---
The Zig Core can pause at a Segment's `begin`, `commit` and `rollback` hooks and at automatic scope abandonment, and resume when the Host answers, for the Message Layer. A paused Operation call no longer changes the Trace: its Run's next record keeps `start` or `resume` instead of `continue`, and the pause ends no Stretch (#900).
