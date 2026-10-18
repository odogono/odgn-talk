---
type: feat
scope: tools
---
Add Folio's `keyUp` PlayMessage so Scripts can track held keys and implement
their own repeat timing. Focus loss releases held keys to avoid stuck input
(#1145).
