---
type: fix
scope: ts
---
An error inside a Join's body that runs a `finally` block in the Join's frame, then is caught outside the body, now abandons the Join's pending members, as the Zig Core does (#1742).
