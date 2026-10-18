---
type: feat
scope: tools
---
Folio runs Play in a supervised worker, so a Script that never yields no longer freezes the editor. Stop ends the worker after 500 ms without an answer (ADR 0107).
