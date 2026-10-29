---
type: fix
scope: ts
---
Declare the TS `sqlite` Capability's errors with their catalogue fields, as the Zig Core does, so a save that holds a `sqlite` Grant restores on either Core instead of failing with `save mismatch` (#1751).
