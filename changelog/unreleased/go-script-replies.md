---
type: feat
---
Add Go `send … and wait` between named Scripts and to ownerless `me`, including replies in `it`, receiver failure propagation, MaxWait timeouts and cancellation that preserves the receiver. Count pending replies and ready answers toward Persistent State, and charge resumption unwinding against Pump budgets. Correct TS suspension accounting for the new 48-byte Script reply wait. Grow the Go corpus gate to 109 cases (#134).
