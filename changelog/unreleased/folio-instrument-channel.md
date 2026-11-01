---
type: fix
scope: tools
---

Folio's Play worker now sends Instrument commands straight to the AudioWorklet over a `MessageChannel`, so a busy or throttled page no longer makes beats sound late.
