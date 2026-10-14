---
type: fix
---
The Zig Core's Message Layer returns each Pump's `run accounting` rows in that Pump's `reports`. Before, it left them out, and a later `reload` could report them from freed memory (#635).
