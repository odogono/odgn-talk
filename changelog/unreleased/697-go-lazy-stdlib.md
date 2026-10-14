---
type: perf
---
Compile each Go Standard Library on first use instead of when the first Group is created. A fresh WASI Message Layer instance that loads and pumps a small Script now holds 7 MiB instead of 17 MiB (#697, #585).
