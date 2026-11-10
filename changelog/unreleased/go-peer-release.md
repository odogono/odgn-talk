---
type: fix
scope: go
---
A `peer` implementation with a `Release` method now hears each Grant's release, so the example peer router withdraws a stopped Script's exposures and frees their names (#2217).
