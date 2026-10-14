---
type: feat
scope: tools
---
Folio now works offline and installs as an app: a service worker keeps the whole shell, updates wait for a reload after autosave, and the manifest registers `.folio` files so an installed Folio opens them from the operating system. Where the browser offers file handles, Save writes back to the opened Project file, refusing one changed on disk; other browsers keep Export's download and Import, and say so (#823).
