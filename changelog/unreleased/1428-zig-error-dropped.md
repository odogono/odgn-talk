---
type: fix
scope: repo
---
Drop an uncaught error's `error` message when its Script's mailbox is full on the Zig Core, with an `error-dropped` note, as chapter 6 says. Host inputs accepted during the Pump count toward the depth. A Zig `send`, or a call to a foreign Function Value, also counts those inputs before refusing as `mailbox full`. The Zig Core used to ignore them, and always queued the error message (#1428).
