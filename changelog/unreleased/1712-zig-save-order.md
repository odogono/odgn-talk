---
type: fix
scope: repo
---

A Zig save writes its open Broadcast Decisions and per-root discard counts in key order, so saving a restored Group gives the same bytes and State Fingerprint as the save it came from.
