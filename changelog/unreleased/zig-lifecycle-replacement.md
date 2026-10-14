---
type: fix
---
Publish Zig Library replacements only after every old Script's lifecycle cleanup succeeds, return `effect state unknown` on fatal cleanup, and refuse worker reentry from lifecycle callbacks (#900).
