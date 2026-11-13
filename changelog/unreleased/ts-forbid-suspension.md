---
type: feat
scope: ts
---

The TS Core takes `forbidSuspension` at Load, refuses any possible Suspension Point in such a Script as `can't suspend here`, and keeps the option through Reload, Extend, Library replacement and restore.
