---
type: feat
---
Add the Session Store to the Zig Core's Session Host: `:grant <name> store [<store>]`, the `store` Operations over in-memory Stores, `:store` and its `load`, `save` and `clear` forms, Store Notifications pumped at the same Clock reading, and `:save` and `:restore` through router checkpoints. The five `sessions/store-*` cases now pass (#629).
