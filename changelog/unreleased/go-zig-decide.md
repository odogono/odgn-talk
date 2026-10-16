---
type: feat
scope: repo
---
Add Decide and DecideBroadcast futures to the experimental Zig-backed Go adapter, settling each when its Verdict seals and cancelling it through its context. The Zig Core now cancels Broadcast Decisions by broadcast id, leaves sealed Decisions alone, and records refused queued calls whose overrides it can't hold (#1011, #1014, #1015).
