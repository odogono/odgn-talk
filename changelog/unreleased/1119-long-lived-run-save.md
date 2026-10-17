---
type: fix
scope: ts
---
Keep a long-lived Run's save from growing with every suspending call it has made: a suspended Run drops the call records the Trace already has (#1119).
