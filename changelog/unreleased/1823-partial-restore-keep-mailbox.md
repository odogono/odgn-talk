---
type: feat
scope: ts
---
`RestoreOptions.keepMailbox` keeps each changed Script's mailbox in a Partial Restore: its messages go to the new code, a Request's sender goes on waiting for the reply, and the kept messages count toward the Persistent State cap. A live `reload` with `keepMailbox` now counts its kept messages toward the cap too, as the Zig Core does (#1823, #1835).
