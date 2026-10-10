---
type: perf
---
Reduce Go Standard Library compilation allocations by reusing one compact parse, smaller syntax nodes and traversal scratch storage. Fresh WASI Message Layer instances stay within 16 MiB after loading and pumping a small Script (#585).
