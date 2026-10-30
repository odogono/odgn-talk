---
type: feat
scope: go
---
`SetCompilationCacheDir(dir)` keeps the compiled Zig reactor in a directory for later processes, as `NORTHTALK_ZIG_CACHE_DIR` does, and wins over it. The reactor compiles once per process, so call it before the first Core needs the reactor; after that it fails (#1841).
