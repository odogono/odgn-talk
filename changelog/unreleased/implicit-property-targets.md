---
type: fix
scope: spec
breaking: true
---
Allow whole Host Object property assignments through `me`, `it` and `the target` consistently across Go, TS and Zig (#744). Bare implicit bindings remain nonassignable; Go no longer accepts ordinary Container mutations rooted in `it`.
