---
type: feat
scope: repo
---
Elixir adds `NorthTalk.send_request/4`, which admits a Request and returns its `NorthTalk.Pending`, with its delivery id, before any Run starts, so a Host Adapter under manual drive knows the id before its first Pump (#2052).
