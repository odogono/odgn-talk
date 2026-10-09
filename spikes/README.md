# Spikes

Finished experiments, kept as the evidence that ADRs and [the research notes](../docs/research/) cite. They are frozen: they sit outside the Bun workspaces and CI, and nothing depends on them ([ADR 0046](../docs/adr/0046-each-core-lives-under-impl-beside-a-shared-spec.md)).

- [`go-wasm/`](go-wasm/): a Go Core built for WASM, measured for ADR 0009 in [the Go→WASM spike](../docs/research/go-wasm-spike.md).
- [`message-layer/`](message-layer/): the message layer over WASI and a sidecar, for [the message-layer research](../docs/research/message-layer.md).
- [`validate-hook/`](validate-hook/): what SQLite can check in literal SQL without a schema, for [the load-time Validate hook](../docs/research/load-time-validate-hook.md).
