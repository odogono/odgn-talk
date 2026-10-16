---
type: feat
scope: repo
---
Verify the Elixir Host's reactor: `mix compile` fetches the pinned reactor release into `priv/` and checks its SHA-256, the compiled module is cached per digest, and `hello`'s save format and required features are checked. An owner takes `:memory_cap`, `:timeout` and default Script `:limits`, and `NorthTalk.memory/1` reports linear memory apart from host memory. A trap or a timeout fails every waiting request with `instance trapped` and stops the owner with `{:shutdown, :trapped}`; nothing is retried. A failed automatic Pump now fails its Group's waiting requests instead of leaving them waiting (#995).
