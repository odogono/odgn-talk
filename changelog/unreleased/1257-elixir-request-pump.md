---
type: feat
scope: repo
---
Elixir adds `NorthTalk.request_pump/5` and `NorthTalk.call_pump/4`, which admit once and Pump once over the negotiated `request-pump-fields-v1` envelope. An admitted call returns a `NorthTalk.Pending` handle you can await repeatedly with `NorthTalk.await/2`, and its Pump outcome stays separate. `NorthTalk.release_pending/1` or closing the Group releases the handle without cancelling the request (#1257).
