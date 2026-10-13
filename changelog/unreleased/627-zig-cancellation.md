---
type: feat
---
Cancel Runs and Deliveries in the Zig Core with `talk_script_cancel_run` and `talk_cancel_delivery`, running a cancelled Run's `finally` blocks on its Cleanup Budget and reporting `cleanup-failed` when they fail (#627).
