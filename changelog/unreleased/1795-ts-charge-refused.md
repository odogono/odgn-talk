---
type: feat
scope: ts
---
A metered Operation whose callback has a `charge` refused now writes `charge-refused=yes` in its `call` record after the accepted `charged`, as the Zig Core does (#1795).
