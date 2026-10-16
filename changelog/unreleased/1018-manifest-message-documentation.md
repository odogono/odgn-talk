---
type: feat
scope: spec
---

A Host Manifest message can carry a `description` and `examples`, as an Operation can, and `ExportManifest` writes them in the TS and Zig Cores. Language servers show them in completion and hover, and the new `message-argument-count` Lint flags a command that gives a message the wrong number of arguments when no Handler in the Script answers it. Folio declares its built-in `hide` and `show` this way, so its Script editor completes and documents them.
