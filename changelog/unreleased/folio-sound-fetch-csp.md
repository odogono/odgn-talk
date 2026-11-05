---
type: fix
scope: tools
---

Folio's sampler plays Project sounds again: the page's Content-Security-Policy now lets Play fetch their `blob:` URLs to decode them, which it had blocked since Instruments arrived (#1894).
