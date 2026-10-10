---
type: feat
scope: tools
---
The REPL and the Playground share one Session Driver, so the Playground now queues lines typed while the session sleeps and runs them when it wakes, as the REPL does, instead of refusing them as busy (#539).
