---
type: fix
scope: repo
---
The Zig Core no longer keeps every settled Request's result for the life of its Group. `talk_pending_release` now drops the result, settled or not, and the Message Layer releases its handles at once, so a long-lived Group's memory no longer grows by about 280 bytes per Request.
