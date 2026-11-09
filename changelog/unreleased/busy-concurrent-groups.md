---
type: fix
scope: spec
---

Say that `sqlite busy` and `store busy` can arise without a Fuel Slice when Groups sharing a database or Store are pumped at the same time, as a multi-tenant Go server does.
