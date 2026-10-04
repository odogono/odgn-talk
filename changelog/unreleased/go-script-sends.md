---
type: feat
---
Add non-waiting Go `send` between named Scripts and to an ownerless Script's `me`, with FIFO mailbox delivery, sender identity, exact message charges and atomic capacity checks. Sent messages reach pending `wait for` observers before Handler dispatch. Grow the Go corpus gate to 105 cases, including the corrected `suspension/wait-for` Trace tracked in #277 (#134).
