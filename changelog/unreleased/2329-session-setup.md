---
type: fix
scope: ts
---
The TS Session Host no longer records an empty `setup` envelope, and replays a Transcript without one as having no object bindings. `:clock advance` refuses a negative duration even when it rounds to nothing.
