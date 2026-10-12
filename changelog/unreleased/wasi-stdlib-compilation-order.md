---
type: fix
---
Compile the Go Standard Libraries in a stable order so fresh WASI instances do not intermittently exceed the 16 MiB startup memory limit because of randomized map iteration.
