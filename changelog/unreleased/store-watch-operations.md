---
type: feat
breaking: true
---
Add Store `watch` and `unwatch` Operations to both Cores, with validated watch names and messages, Grant release cleanup and router-backed bundled Stores (#620). Store implementations must now supply `watch`, `unwatch` and `release`, and factory cost maps must include both new Operations. Session driving and checkpoint integration follow in #621.
