---
type: fix
scope: repo
---
A Zig Group driven through the Message Layer, as the Go, TS and Elixir Hosts drive it, no longer grows its memory with every settled suspending call: it frees retired calls the Host has heard settle, and keeps the issued call ids of Runs that made the same calls as one span.
