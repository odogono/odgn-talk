---
type: feat
scope: repo
breaking: true
---
A Library replacement can keep every reloaded importer's mailbox, as a Reload's `keepMailbox` does: the kept messages go to the new code and count toward each Script's Persistent State cap, and the Trace's `replace-library` record writes `mailbox=keep`. In TS pass `replaceLibrary(library, carry, { keepMailbox: true })`, in Go `ReplaceLibrary(l, carry, ReloadOptions{KeepMailbox: true})`, and on the message layer `keepMailbox` on `replace-library`. In C, `talk_replace_library` now takes a `const talk_reload_options *` before `reports`; pass `NULL` to keep the old behaviour. Folio's Library Punch In now keeps its importers' mailboxes (#1951).
