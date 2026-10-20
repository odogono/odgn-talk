---
type: fix
scope: repo
---
Drop an uncaught error's `error` message when its Script's mailbox is full on the Zig Core, with an `error-dropped` note, as chapter 6 says. Host inputs accepted during the Pump count toward the depth. The Zig Core used to queue the message regardless (#1428).
