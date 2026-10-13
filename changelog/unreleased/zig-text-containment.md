---
type: fix
---
Avoid a temporary copy during ASCII text concatenation in the Zig Core, so
text doubling reaches its Allocation Limit Fault under a 1 GiB WASI instance
cap at the conformance minimum limits (#804).
