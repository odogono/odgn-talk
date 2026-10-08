---
type: feat
---

Both Cores can rewind a Run that hasn't passed a Suspension Point (ADR 0068): `RewindRun` lands like `CancelRun`, rolls back its Segment, puts its message back at the head of the mailbox and ends the Pump as `rewound`. `Reload` can keep the mailbox, so the same message runs again on the edited code. This is the Core side of the debugger's Fix and Continue (#433).
