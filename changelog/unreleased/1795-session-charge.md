---
type: feat
scope: spec
---
A Session can make charge requests: `:mock <capability>.<operation> suspending read-only` defines a metered mock, and `:charge <call> <fuel>` queues a request for its pending call and pumps, in the TS, Zig and Go REPLs. The Zig Core now writes a refused charge request before the next Host Input record, as the TS Core does (#1795).
