---
type: fix
scope: tools
---
Folio's `offline` browser suite no longer hangs: the test server now serves a directory's `index.html`, so the service worker's install can cache the Example Project pages, and the suite fails within 10 s if no worker becomes active (#1727).
