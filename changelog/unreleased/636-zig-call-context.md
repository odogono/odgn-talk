---
type: feat
---
The Zig Core's talk.h now declares every talk.go name. `talk_call_context` tells a Host, from any thread, once a suspending call is abandoned by a failed Join, a cancelled Run, a stop, a timeout or a restore that lost it. `talk_store_coordinator` gives the Core's copy of a `store` implementation's coordinator, which a `sqlite` implementation may give for the same database so both share a Segment's participant (#636).
