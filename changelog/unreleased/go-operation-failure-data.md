---
type: fix
---
Reject invalid Go Operation failure Data as `host error` with a `CallFailed` report, and preserve Error maps in returned-call and deferred `Call.Fail` traces when Data keys collide with the failure envelope. Valid Nothing/map failures retain their conversion costs (#306).
