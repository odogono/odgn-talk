---
type: feat
breaking: true
---
Implement `otherwise` and optional map-key reads in the Zig Core: `a otherwise b` evaluates `b` only when `a` is Nothing, and `the optional k of x` reads a map key from a map or Nothing and rejects every other receiver, including Host Objects (#721).

`otherwise` can no longer be an Argument Label, and a chunk index variable named `otherwise` must be grouped: write `item (otherwise) of xs`.
