---
type: feat
scope: repo
---
The Zig Core and the Go API can keep each changed Script's mailbox in a Partial Restore: set `keep_mailbox` in `talk_restore_options`, `keepMailbox` on the `restore` request, or `RestoreOptions.KeepMailbox` in Go. Queued messages go to the new code, and a Request's sender goes on waiting for its reply (#1822).
