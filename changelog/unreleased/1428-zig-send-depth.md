---
type: fix
scope: repo
---
Count Host inputs accepted during the Pump when a Zig `send`, or a call to a foreign Function Value, checks the receiver's mailbox depth, as TS and native Go do. The Zig Core used to accept a send into a mailbox those inputs had already filled (#1428).
