---
type: perf
scope: repo
---
Cut the experimental Go Zig adapter's allocation: a request allocates 44 KiB instead of 167 KiB and a new Group 2.3 MiB instead of 5.6 MiB, by caching the guest's exports and reserving a loaded Group's guest memory up front (#1103).
