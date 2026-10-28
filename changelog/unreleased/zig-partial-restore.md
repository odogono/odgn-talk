---
type: feat
scope: repo
---

Restore a Group whose Libraries changed with the Zig Core and Go API's `ReloadChanged` policy: Scripts whose code still matches keep their Runs, and only the changed ones are rebuilt, carrying their Script Variables. `RestoreResult.Reloaded` and C's `talk_restore_result_reloaded` list the rebuilt Scripts.
