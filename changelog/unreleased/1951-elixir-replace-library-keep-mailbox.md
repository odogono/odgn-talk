---
type: feat
scope: repo
---
The Elixir Host pins `reactor-v0.18.0`, and `NorthTalk.replace_library/3` takes `keep_mailbox: true`, so every Script a Library replacement reloads keeps its queued messages for the new code (#1951).
