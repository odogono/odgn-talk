# Elixir task navigation

Find the heading for your task, then read the linked files, rules and tests. Every file this package has is listed in
the [README's layout](README.md#layout). The owner is
[`owner.ex`](lib/north_talk/owner.ex), and it is large, so search it for the function you need instead of
reading all of it. For `spec/09-embedding.md`, open the anchor given here, not the whole chapter. For domain
terms, use [GLOSSARY.md](../../GLOSSARY.md).

Commands run from `impl/elixir/` unless they say otherwise.

## Setup and checks

- On a fresh worktree, build the reactor the tests use, then fetch the deps:
  `(cd impl/zig && zig build -Dtarget=wasm32-wasi --prefix ../../.cache/zig-wasi)` from the repository root,
  then `cd impl/elixir && mix deps.get`.
- How the reactor is found: [`artifact.ex`](lib/north_talk/artifact.ex) `path/0` tries `NORTH_TALK_WASM`, then
  `config :north_talk, wasm_path:`, then `priv/talk.wasm`. In tests, [`config.exs`](config/config.exs) sets
  `wasm_path` to `.cache/zig-wasi/bin/talk.wasm` at the repository root.
- **After pulling or changing Zig code, run the `zig build` above again.** Nothing rebuilds
  `.cache/zig-wasi/bin/talk.wasm` for you, so the tests keep running the old reactor.
- To try another reactor, run `NORTH_TALK_WASM=/path/to/talk.wasm mix test`.
- No sidecar is used here. The native sidecar is for the [benchmark Host](../../bench/message-layer/elixir/) only.
- One file: `mix test test/capability_test.exs`. One test: `mix test test/capability_test.exs:152`.
- CI runs `mix format --check-formatted`, `mix compile --warnings-as-errors` and `mix test` here, and
  `mix format --check-formatted` and `mix test` in `examples/shop/` ([workflow](../../.github/workflows/zig.yml)).
- Formatting: each Mix project has its own [`.formatter.exs`](.formatter.exs), and
  [`examples/shop`](examples/shop/.formatter.exs) and the [benchmark Host](../../bench/message-layer/elixir/.formatter.exs)
  each have one too. Run `mix format` from the project that owns the files you changed, or pass it only those
  files, as in `mix format lib/north_talk/value.ex test/value_test.exs`. Run `git diff --stat` afterwards, and
  revert anything it touched outside your change.

## Public API, Results and Script Groups

- Files: [`north_talk.ex`](lib/north_talk.ex), [`group.ex`](lib/north_talk/group.ex), [`errors.ex`](lib/north_talk/errors.ex)
- Rules: [the shape](../../spec/09-embedding.md#the-shape), [Deliveries](../../spec/09-embedding.md#deliveries), [Run accounting](../../spec/09-embedding.md#run-accounting)
- Copy from: [`owner_test.exs`](test/owner_test.exs). Handler, `return` and `script variable` Scripts are written inline there.
- Check: `mix test test/owner_test.exs`

## Values and the Value Encoding

- Files: [`value.ex`](lib/north_talk/value.ex), [`types.ex`](lib/north_talk/types.ex), [`map.ex`](lib/north_talk/map.ex), [`clock.ex`](lib/north_talk/clock.ex)
- Rules: [Values at the boundary](../../spec/09-embedding.md#values-at-the-boundary), [JSON and the Value Encoding](../../spec/09-embedding.md#json-and-the-value-encoding), [Shapes](../../spec/09-embedding.md#shapes), [ADR 0092](../../docs/adr/0092-the-elixir-host-represents-bytes-and-ordered-maps-as-structs.md)
- Copy from: [`value_test.exs`](test/value_test.exs), and the round-trip test in [`function_test.exs`](test/function_test.exs)
- Check: `mix test test/value_test.exs`

## Function Values

- Files: `NorthTalk.Function` in [`types.ex`](lib/north_talk/types.ex), `call/4` and `release/1` in [`north_talk.ex`](lib/north_talk.ex)
- Rules: [Function Values at the boundary](../../spec/09-embedding.md#function-values), [the value](../../spec/03-values.md#function-values), [Lambdas](../../spec/04-expressions-and-statements.md#lambdas)
- Copy from: [`function_test.exs`](test/function_test.exs). A Lambda is written `given x: x + n`, and a Function Value is called as `f(x)`.
- Check: `mix test test/function_test.exs`

## Capabilities, Operation declarations and callbacks

- Files: [`capability.ex`](lib/north_talk/capability.ex). Its moduledoc lists every `operation` option.
- Rules: [Capabilities](../../spec/09-embedding.md#capabilities), [Shapes](../../spec/09-embedding.md#shapes), [`ask` in Scripts](../../spec/04-expressions-and-statements.md#capabilities), [Grants and `needs`](../../spec/07-libraries-and-the-standard-library.md#grants-and-needs), [Operation naming guide](../../spec/09-embedding.md#operation-naming-guide)
- Copy from: [`capability_test.exs`](test/capability_test.exs) for `use NorthTalk.Capability`, `Capability.from_functions/3`, `ask stock to reserve sku and wait`, `{:defer, ref}` and timeouts. [`examples/shop/lib/shop/stock.ex`](examples/shop/lib/shop/stock.ex) is a complete Capability.
- Gotcha: `args:` defaults to `[]`, so an Operation declared without it takes no arguments. Declare one Shape per argument, such as `args: ["text"]`, or `["any"]` for any data value.
- Check: `mix test test/capability_test.exs`

## Capability Scopes, Segment-bound effects and the Grant release hook

- Files: [`capability.ex`](lib/north_talk/capability.ex) (`NorthTalk.Effect`, `NorthTalk.Release`), [`owner.ex`](lib/north_talk/owner.ex)
- Rules: [Capability Scopes and Segment-bound effects](../../spec/09-embedding.md#capability-scopes-and-segment-bound-effects), [The Grant release hook](../../spec/09-embedding.md#the-grant-release-hook)
- Copy from: [`lifecycle_test.exs`](test/lifecycle_test.exs) for the `scope:` and `segment_bound: true` declarations
- Check: `mix test test/lifecycle_test.exs`

## Changing code: reload, Libraries and extend

- Files: [`north_talk.ex`](lib/north_talk.ex), [`group.ex`](lib/north_talk/group.ex), [`owner.ex`](lib/north_talk/owner.ex)
- Rules: [Loading and Libraries](../../spec/09-embedding.md#loading-and-libraries), [Reload and extend](../../spec/10-save-and-restore.md#reload-and-extend)
- Copy from: [`lifecycle_test.exs`](test/lifecycle_test.exs) for `reload/4`, `replace_library/3`, `extend/3` and `use … from user`
- Check: `mix test test/lifecycle_test.exs`

## Save and restore

- Files: `NorthTalk.Restored` and `NorthTalk.PendingCall` in [`group.ex`](lib/north_talk/group.ex), [`owner.ex`](lib/north_talk/owner.ex), `@save_format` in [`artifact.ex`](lib/north_talk/artifact.ex)
- Rules: [Saving](../../spec/10-save-and-restore.md#saving), [Restoring](../../spec/10-save-and-restore.md#restoring), [ADR 0008](../../docs/adr/0008-same-core-save-restore.md)
- Copy from: [`restore_test.exs`](test/restore_test.exs) for `settle/3` with `:reissue` and `{:adopt, ref}`
- Check: `mix test test/restore_test.exs`; from the root, `impl/elixir/scripts/check-save-format.sh`

## The Message Layer, the owner and Pumps

- Files: [`owner.ex`](lib/north_talk/owner.ex), [`transport.ex`](lib/north_talk/transport.ex), [`transport/wasi.ex`](lib/north_talk/transport/wasi.ex)
- Rules: [the Message Layer](../../spec/09-embedding.md#the-message-layer), [The Pump and the Group Fingerprint](../../spec/09-embedding.md#the-pump-and-the-group-fingerprint), [Time and reports](../../spec/09-embedding.md#time-and-reports); the Zig side is in the [Zig task map](../zig/NAVIGATION.md)
- Copy from: [`owner_protocol_test.exs`](test/owner_protocol_test.exs) for a wrapping transport that observes frames and injects faults, [`owner_test.exs`](test/owner_test.exs) for `drive: :manual`, [`transport_test.exs`](test/transport_test.exs), [`clock_test.exs`](test/clock_test.exs)
- Check: `mix test test/owner_protocol_test.exs test/transport_test.exs`

## Host errors, limits and faults

- Files: [`errors.ex`](lib/north_talk/errors.ex), [`owner.ex`](lib/north_talk/owner.ex), [`transport/wasi.ex`](lib/north_talk/transport/wasi.ex)
- Rules: [Host error catalogue](../../spec/09-embedding.md#host-error-catalogue), [Limits](../../spec/06-errors-and-limits.md#limits), [Limit Faults](../../spec/06-errors-and-limits.md#limit-faults), [README: Limits and faults](README.md#limits-and-faults)
- Copy from: [`fault_test.exs`](test/fault_test.exs) for traps, `:memory_cap` and timeouts
- Check: `mix test test/fault_test.exs`

## The pinned reactor release

- Files: `@release`, `@sha256` and `@save_format` in [`artifact.ex`](lib/north_talk/artifact.ex), [the compile step](lib/mix/tasks/compile.north_talk_reactor.ex), [the release workflow](../../.github/workflows/elixir-reactor.yml), [`check-save-format.sh`](scripts/check-save-format.sh)
- Steps: pushing a `reactor-v*` tag publishes the reactor. Then set `@release` to the tag and `@sha256` to the published file's digest. `mix compile` refuses a download whose digest differs.
- Check: from `examples/shop/`, run `mix deps.get && mix test`. It fetches the pinned release, because nothing overrides the reactor there.

## The OTP example

- Files: [`examples/shop/`](examples/shop/) and its [README](examples/shop/README.md); [`shop.ex`](examples/shop/lib/shop.ex) holds its Script
- Check: `cd examples/shop && mix deps.get && mix test`
