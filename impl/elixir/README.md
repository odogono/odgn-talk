# NorthTalk for Elixir

An Elixir embedding of NorthTalk, backed by the Zig Core's `wasm32-wasi` reactor in [Wasmex](https://hex.pm/packages/wasmex). It speaks the [Message Layer](../../spec/09-embedding.md#the-message-layer) and needs neither Go nor a sidecar. [#963](https://github.com/odogono/odgn-talk/issues/963) tracks the rest of the application-facing API.

It supports Elixir 1.17 or later on OTP 27 or later, with Wasmex 0.15.1. To change this package, start with the [task map](NAVIGATION.md).

```sh
cd impl/zig && zig build -Dtarget=wasm32-wasi --prefix ../../.cache/zig-wasi
cd ../elixir
mix deps.get
mix test          # uses .cache/zig-wasi/bin/talk.wasm
```

[`examples/shop`](examples/shop/) is a runnable OTP application and the getting-started guide: Elixir calls a Handler, which calls Elixir and Erlang functions, and a deferred Operation is settled later by another process.

## Using it

An Instance Owner is one process holding one reactor instance. It conducts every exchange with that instance, and can drive several Script Groups.

```elixir
children = [{NorthTalk, name: MyApp.Talk}]

group = NorthTalk.new_group!(MyApp.Talk, "tenant-1", [])
"pricing" = NorthTalk.load!(group, "pricing", "on total a, b\n  return a + b\nend total\n", [])
{:ok, %NorthTalk.Result{value: value, report: report}} =
  NorthTalk.request(group, "pricing", "total", [1, Decimal.new("2.50")])
```

- **Results:** each call returns `{:ok, _}` or `{:error, error}`, where `error` is a `NorthTalk.HostError`, `NorthTalk.LoadError` or `NorthTalk.ScriptError`. The `!` variants raise it instead. `deliver/4` returns once the message is accepted. `request/5` returns once its Run ends, with the `run end` report and its Fuel.
- **Driving:** by default the owner Pumps a Group after each delivery, one Fuel Slice per Pump. Each slice is a separate message to the owner, so other work interleaves. It Pumps again at the Group's next deadline. With `drive: :manual`, the caller calls `pump/2` with its own Clock readings.
- **Values:** see `NorthTalk.Value`. Numbers are integers or `Decimal`s, and floats are refused. Text is a UTF-8 binary, normalised to NFC, and Bytes are `NorthTalk.Bytes`. A map is a `NorthTalk.Map`, in order; a plain map with at most one key is accepted on input ([ADR 0092](../../docs/adr/0092-the-elixir-host-represents-bytes-and-ordered-maps-as-structs.md)). Quantities, ranges, Instants, Civil Dates, Patterns and Host Objects are `NorthTalk.*` structs, and `DateTime`, `Date` and `NaiveDateTime` are accepted on input. Decoding refuses any form the encoder wouldn't write, and never creates atoms.
- **Combined request and Pump:** `request_pump/5` and `call_pump/4` admit a message or Function call and Pump its Group once, in one exchange, under either drive. They use the binary `request-pump-fields-v1` envelope ([the contract](../../spec/embedding/request-pump-binary.md)), and are refused with `invalid value` before admission when the reactor doesn't offer it. An admission refusal is `{:error, error}`, with no Pump. Otherwise the call returns `{:ok, %NorthTalk.Pumped{pending: pending, pump: outcome}}`, where `outcome` is `pump/2`'s result, or `{:error, error}` when the Pump was refused and the request is left queued. `await/2` waits for the pending request's result as `request/5` would, and can be called again. A timeout is a `HostError` with code `timeout`, and the Run carries on. `release_pending/1` discards the result and fails awaiters with `pending released`, but doesn't cancel the request. `close_group/1` releases a Group's handles. With `binary_callbacks: true` on `start_link/1` (or `config :north_talk, binary_callbacks: true`), the owner also requests `callbacks-fields-v1` when offered, so op, prop, effect and release needs and results use binary frames even during a JSON exchange. Other needs stay JSON. It is off by default until it is faster than JSON ([#1316](https://github.com/odogono/odgn-talk/issues/1316)); older reactors fall back automatically.

  ```elixir
  {:ok, %NorthTalk.Pumped{pending: pending}} = NorthTalk.request_pump(group, "pricing", "total", [items])
  {:ok, %NorthTalk.Result{value: total}} = NorthTalk.await(pending)
  :ok = NorthTalk.release_pending(pending)
  ```

- **Function Values** a Script returns, or passes to a callback, are `NorthTalk.Function` handles bound to their Group and owner. `call/4` calls one through its Group as `request/5` sends a message, and one can be passed back into the same Group. A handle is held until `release/1`, or until `close_group/1` or the owner closes; there are no finalisers. Using one after that, or through another Group, is a `HostError`: `function released`, `group closed`, `instance closed` or `wrong group`. `close_group/1` acts on the Host's side only, since the Core has no message that frees a Group.

  ```elixir
  {:ok, %NorthTalk.Result{value: add2}} = NorthTalk.request(group, "pricing", "adder", [2])
  {:ok, %NorthTalk.Result{value: 5}} = NorthTalk.call(group, add2, [3])
  :ok = NorthTalk.release(add2)
  ```

- **Capabilities:** a module that uses `NorthTalk.Capability` declares Operations, each answered by a function of the same name. `define_capability/2` gives it to an owner, `grant/3` grants some or all of its Operations with a binding, and `load/4` takes the Grants under the names the Script uses. Calls dispatch through the Script's Grant, so Operations of the same name in different Capabilities never collide.

  ```elixir
  defmodule MyApp.Stock do
    use NorthTalk.Capability, name: "stock"

    operation "count", args: ["text"], result: "number", cost: 1
    def count([sku], call), do: {:ok, MyApp.Stock.count(call.binding, sku)}

    operation "reserve", mode: :suspending, args: ["text"], result: "text", cost: 5
    def reserve([sku], call), do: {:defer, MyApp.Orders.reserve_later(sku)}
  end

  :ok = NorthTalk.define_capability!(MyApp.Talk, MyApp.Stock)
  grant = NorthTalk.grant!(MyApp.Talk, MyApp.Stock, binding: "warehouse-1")
  NorthTalk.load!(group, "orders", source, grants: %{"stock" => grant})
  # later, when the reservation is made:
  :ok = NorthTalk.answer(MyApp.Talk, ref, "R-1001")
  ```

- **Callbacks** run in monitored Tasks, never in the owner. The owner waits up to the Capability's `:timeout`, 5 s by default, for an immediate or fire-and-forget callback, so one must not call its own owner. A suspending callback runs while the owner carries on; it returns `{:ok, value}` or `{:error, failure}`, or `{:defer, ref}` to settle later. Its call has no timeout of its own: it ends when settled, or when the Core abandons it at its `max_pending`, the Script's wait limit or the end of its Run, which kills its Task or forgets its ref. A suspending callback may call the owner, but must not wait for a Run that needs its own call settled. A raise, an exit, a timeout or an unexpected result is a Host failure: the Script raises `host error`.
- **Lifecycle hooks:** an Operation may open or close a Capability Scope (`scope:`) or be Segment-bound (`segment_bound: true`). A Capability with Segment-bound Operations defines `effect/2`, its Segment participant's `begin`, `commit` and `rollback` hooks, returning `:ok`, `:failed` or `:unknown`. Anything else, a raise or a timeout is `unknown`, which stops the Group with `effect state unknown`. `release/1`, the Grant release hook, runs when a Script's Grant stops being effective, with reason `:stop`, `:reload`, `:revoke` or `:disable`; what it returns is ignored. Hooks run in Tasks, like callbacks, and the Core's order holds: a scope left open is abandoned by an automatic call (`call.automatic`), then the participant commits or rolls back, then Grants are released, all before the reply or report that follows.
- **Changing code:** `reload/4` stops and reloads a Script, carrying its Script Variables over unless `variables: :reset`; `replace_library/3` does so for every Script importing a Library, all or nothing; `extend/3` adds names without stopping anything. `stop/3` stops a Script. A Run discarded by any of them fails its waiting request with a `NorthTalk.ScriptError` of outcome `"discarded"`.
- **Save and restore:** `save/1` returns a Group's bytes, refused with `effects pending` while a scope or participant is live. `restore/4` makes a new Group from them in this or another owner, rebinding each Script's Grants through `grants:`; a Grant not given restores revoked. Each pending call in the `NorthTalk.Restored` is settled with `settle/3`: an answer, a failure, `:reissue`, which calls its callback again, or `{:adopt, ref}`, settled later by `answer/3` or `fail/3`. An automatic owner first Pumps a restored Group once every pending call is settled; any still unsettled at the first Pump fails with `call lost`. Saves are per Core: only a Zig Core reads one. Grant bindings, callbacks and waiting requests are not saved, so `:reports_to` gets the outcome of a Run that was waited on.
- **Lost instances:** if the reactor is lost other than by a trap or a timeout ([Limits and faults](#limits-and-faults)), such as by a malformed reply, the owner fails every waiting request with `instance lost` and stops, so its supervisor can restart it.

## Not offered

This Host speaks only part of the [Message Layer](../../spec/09-embedding.md#the-message-layer):

- **Host Objects** are not supported yet: a property need is refused, an Object Collection's `prop` need (`op` `count`, `at` or `find`) included, and every saved Host Object restores disposed. Without Object Kind declarations this Host has no collections to declare, and doesn't ask for `object-elements-v1`.
- **Function Values** come with the full value set in [#993](https://github.com/odogono/odgn-talk/issues/993). They hold only a token, so nothing about them is durable on the Host's side.
- **Standard Capabilities** are not offered. The `sqlite` factory isn't offered through the Message Layer by any Host.
- **Paused-crossing inputs** (`paused-inputs-v1`, #884) aren't offered: nothing a callback sends the owner is admitted before its own result. A suspending callback's calls are handled after the exchange it belongs to ends. [#1007](https://github.com/odogono/odgn-talk/issues/1007) tracks it.
- **Revoke, cancellation, Broadcasts, Decisions, inspection, Fingerprints, Store Notification checkpoints, metering and the Host Manifest** have no Elixir API yet.

## The reactor

`NorthTalk.Artifact.path/0` looks for the reactor in this order:

1. The `NORTH_TALK_WASM` environment variable.
2. `config :north_talk, wasm_path: ...`.
3. The package's `priv/talk.wasm`.

The package pins one reactor release by tag and SHA-256 in [`artifact.ex`](lib/north_talk/artifact.ex). `mix compile` fetches it into `priv/` and verifies it, unless an override is set, so a consumer needs neither Go nor Zig. The [Elixir reactor workflow](../../.github/workflows/elixir-reactor.yml) publishes a release when a `reactor-v*` tag is pushed, and its digest is then pinned here. CI fails when the Zig Core's save format differs from the pinned `@save_format`: a PR that changes it sets the new format, tags that commit, and pins the release in the same PR.

The compiled module is cached in `:persistent_term` per SHA-256. Before an owner makes any Group, `hello` must report the save format this package reads and its required features, or the owner refuses to start with `incompatible core`.

The test configuration points at the repository's `.cache/` build.

## Limits and faults

- **Limits:** `:memory_cap` bounds guest linear memory, `:timeout` bounds each reactor call, and `:limits` sets the Script limits each `load/4` starts from, which its own `limits:` may override. `NorthTalk.memory/1` reports linear memory apart from the BEAM's own. A Group out of memory under the cap fails its waiting requests with `out of memory`.
- **Traps and timeouts** poison the instance: the owner fails every waiting request with `instance trapped` and stops with `{:shutdown, :trapped}`. Effects are never retried. To carry on, start a new owner and `restore/4` a save kept from before. Other owners are unaffected.

## Measurements

On an Apple M5 at `aa32a4d8`, through `NorthTalk` with the pinned reactor, from [the benchmark Host's `api` section](../../bench/results/2026-10-16-aa32a4d8-message-layer-elixir-darwin-arm64-apple-m5.md):

| Path | p50 | p99 |
| --- | --- | --- |
| `request/5` of an empty Handler | 112 µs | 143 µs |
| One immediate callback, inside a Run | 64 µs | 90 µs |
| `request/5` waiting on a deferred Operation | 320 µs | 395 µs |

The [callback envelope comparison for #1315](../../bench/results/elixir-callbacks/2026-10-19-darwin-arm64/README.md)
records both encodings on the same reactor. Immediate integer callbacks were
16–22% slower in fields mode on that workstation; property-refusal timings
were mixed. The binary protocol support does not establish an Elixir speedup.

Each owner holds about 2.1 MiB of guest linear memory and 0.2 MiB of process heap after one Request. The raw-frame transport figures are in the same report: the owner and its callback Tasks add to them.

## Layout

| Path | Contents |
| --- | --- |
| [`lib/north_talk.ex`](lib/north_talk.ex) | The public API. |
| [`examples/shop/`](examples/shop/) | The OTP example and getting-started guide. |
| [`lib/north_talk/owner.ex`](lib/north_talk/owner.ex) | The Instance Owner: exchanges, needs, Pumps and waiting requests. |
| [`lib/north_talk/capability.ex`](lib/north_talk/capability.ex) | Capabilities, Grants, and the `NorthTalk.Call`, `NorthTalk.Effect` and `NorthTalk.Release` a callback or hook gets. |
| [`lib/north_talk/group.ex`](lib/north_talk/group.ex) | Group and Library handles, a restore's `NorthTalk.Restored` and `NorthTalk.PendingCall`s, and a combined call's `NorthTalk.Pumped` and `NorthTalk.Pending`. |
| [`lib/north_talk/binary.ex`](lib/north_talk/binary.ex) | The Request/Pump and callback binary fields envelopes, converted to and from the JSON form the owner reads. |
| [`lib/north_talk/value.ex`](lib/north_talk/value.ex) | Value conversion. |
| [`lib/north_talk/types.ex`](lib/north_talk/types.ex) | The value structs, and `NorthTalk.Function` handles. |
| [`lib/north_talk/transport.ex`](lib/north_talk/transport.ex) | The transport behaviour: one frame in, one frame out. |
| [`lib/north_talk/transport/wasi.ex`](lib/north_talk/transport/wasi.ex) | The reactor in Wasmex: compiling, instantiating, guest linear memory and `talk_buffer`/`talk_send`. |
| [`lib/north_talk/artifact.ex`](lib/north_talk/artifact.ex) | The pinned reactor release, where the reactor is found, and what this Host requires of it. |
| [`lib/mix/tasks/compile.north_talk_reactor.ex`](lib/mix/tasks/compile.north_talk_reactor.ex) | The compile step that fetches and verifies the pinned reactor. |

The [Elixir benchmark Host](../../bench/message-layer/elixir/) measures this transport.
