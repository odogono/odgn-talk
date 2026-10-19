---
type: perf
scope: repo
---

Find and drop a Group by handle in the Zig guest's Message Layer through a hash map instead of scanning the Group list, so `new-group`, `load`, `drop-group` and every Group-addressed frame no longer slow down as live Groups pile up (#1329).
