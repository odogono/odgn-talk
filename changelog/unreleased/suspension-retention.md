---
type: fix
scope: ts
---
Count pending suspending Operations, foreign Function Value calls and event-wait captures and object filters before accepting a suspension. Retention faults abandon pending calls while preserving work already started (#281).
