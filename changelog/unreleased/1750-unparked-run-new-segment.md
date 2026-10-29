---
type: fix
scope: ts
---

In the TS Core, a Run unparked by a `queued` clause goes on in a new Segment, so its later Segment ids and saves match the Zig Core's.
