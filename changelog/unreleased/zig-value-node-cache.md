---
type: perf
---
Cache freed Value nodes per Group in the Zig Core — at most 128 nodes counted
against the Group's physical cap — removing nearly every parent allocation from
scalar-heavy Runs and speeding Host-allocator configurations by 7–9% on
arithmetic and call workloads (#878).
