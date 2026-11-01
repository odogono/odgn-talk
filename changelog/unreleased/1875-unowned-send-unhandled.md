---
type: fix
scope: ts
---
Report `unhandled`, with no Delivery id, when a Script sends to an object with no Owning Script on its Message Path or its message climbs past the last one, as the Zig Core does (#1875).
