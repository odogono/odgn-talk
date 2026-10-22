---
type: feat
scope: repo
---
Give a Host function's Call the delivery id of the Host Delivery that started its Run: `Call.delivery` in TS, `Call.Delivery()` in Go, `talk_call_delivery` in C, and an optional `delivery` on the Message Layer's `op` need. A Run that a Script's `send`, a Function Value call or a Join started has none (ADR 0125).
