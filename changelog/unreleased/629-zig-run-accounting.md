---
type: feat
---
Report Run accounting from the Zig Core: `run started` and `run discarded` as they happen, then each Host call's `run accounting` and `causal work` tail. Ancestry and discard counts survive a save, and `talk_restore_result_reports` returns a restore's baseline. The Core passes the shared `impl/testdata/run-accounting.json` fixtures (#629).
