---
type: feat
scope: repo
---
Let Elixir Hosts define Capabilities with `use NorthTalk.Capability` and issue Grants with their own bindings. Immediate, fire-and-forget and suspending Operations run in monitored Tasks, and a suspending one can defer and settle later through `NorthTalk.answer/3` or `NorthTalk.fail/3` (#992).
