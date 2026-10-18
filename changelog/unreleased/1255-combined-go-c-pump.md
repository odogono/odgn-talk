---
type: feat
scope: repo
---
Add Go and C combined Request/Pump and Function-call/Pump APIs. Each admits once
and performs one Pump, retaining the delivery id and Pending on Pump refusal.
The experimental Go Zig backend negotiates the fields binary envelope by default.
