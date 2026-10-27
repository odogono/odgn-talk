---
type: fix
scope: ts
---

Passing plain JS where a Value is expected, as in `script.invoke('hit', 'bob')`, now gives an error that names the call, the argument's position and its JS type. It suggests `text()`, `num()` or `toValue()`, or `script.handlers.<name>(...)` for a named Handler. This works on both Cores and for `invoke`, `request`, `deliver`, `decide`, `broadcast`, `call` and `callPump`.
