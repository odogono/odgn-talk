---
type: perf
scope: ts
breaking: true
---

Move each Built-in's call notation and description out of the TS Core's browser bundle, saving 4.4 KB minified (1.5 KB gzipped). `builtins` from `@odgn/northtalk` no longer has `call` and `gives`; read them from `builtinDocs` in `@odgn/northtalk/session`, keyed by name (#663).
