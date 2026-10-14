---
type: fix
---
Carry an Operation's `description` and `examples` through the Zig Core's Message Layer `define-capability`, refusing documentation of the wrong kind instead of silently dropping it, as the other Cores do (ADR 0076) (#857).
