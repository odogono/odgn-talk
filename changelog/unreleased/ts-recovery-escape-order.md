---
type: fix
scope: ts
---

When an error escapes a Recovery policy, run the policy's own `finally` blocks and the failure's retained cleanup before searching outward from the catching `try`, as chapter 6 says and the Zig Core does. A Guard on an outer catch now sees what those blocks wrote, and the Fuel follows (#1737).
