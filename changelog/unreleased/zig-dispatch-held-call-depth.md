---
type: fix
scope: repo
---
The Zig Core's call-depth check now counts the failed frames a catch holds while it chooses a handler, as the TS Core does (#1736).
