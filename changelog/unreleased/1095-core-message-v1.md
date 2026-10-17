---
type: fix
scope: repo
---
With the Message Layer's new `core-message-v1` feature, a Core-raised error map crosses as `$coreError`, so a Go Session on the Zig adapter leaves its `message` out of the Trace as native Go does.
