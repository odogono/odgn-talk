---
type: feat
scope: ts
---

The TS Core's `restore` accepts `onMismatch: 'reload changed'`. When the only mismatch is Script code, it continues the Scripts whose code matches and rebuilds each changed Script from its new code with its Script Variables carried over, as a Reload would. `RestoreResult.reloaded` and the Trace `restore` record (`mode=partial`, `reloaded=[…]`) list the rebuilt Scripts (#1707).
