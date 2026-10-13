---
type: fix
---
In the Zig Core, `on error "code"` is short for `on error {code: "code"}`, an `error` message never chains or reports `unhandled`, a one-part `move:` isn't a Selector, and a message to a Script keeps that Script's owner as `the target` when it climbs.
