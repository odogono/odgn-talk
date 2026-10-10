---
type: fix
---
Reduce the Go Core's source-loading memory overhead and remove quadratic scans
of long operator chains. The sidecar now drains oversized frames, replies with
a protocol error and continues serving the same Session (#583).
