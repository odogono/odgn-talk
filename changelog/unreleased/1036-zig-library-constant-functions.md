---
type: fix
scope: repo
---
Bind Function Values in Zig Library Constants and parameter defaults to each caller, including nested values and transitive imports, instead of raising `function gone` (#1036).
