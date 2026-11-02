---
type: fix
scope: tools
---

The LSP and Lints recognise every spelling of a labelled Host Command that ADR 0160 allows, such as `play "rain" with {repeat: true}` without `on`, so hover, signature help and the `shadowed-host-command` Lint cover them.
