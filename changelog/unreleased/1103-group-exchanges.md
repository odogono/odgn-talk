---
type: feat
scope: repo
---
Add opt-in `group-exchanges-v1` to the Message Layer: each Group has its own exchange, so one Group's Pump paused at a Host callback no longer holds up the other Groups in its Session, and `drop-group` frees an idle Group. The Zig Core implements it (#1103).
