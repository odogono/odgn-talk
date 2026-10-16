# NorthTalk for Elixir

An Elixir embedding of NorthTalk, backed by the Zig Core's `wasm32-wasi` reactor in [Wasmex](https://hex.pm/packages/wasmex). It speaks the [Message Layer](../../spec/09-embedding.md#the-message-layer) and needs neither Go nor a sidecar. [#963](https://github.com/odogono/odgn-talk/issues/963) tracks the rest of the application-facing API: the full value set and Function Values (#993), a verified reactor release and fault recovery (#995).

It supports Elixir 1.17 or later on OTP 27 or later, with Wasmex 0.15.1.

```sh
cd impl/zig && zig build -Dtarget=wasm32-wasi --prefix ../../.cache/zig-wasi
cd ../elixir
mix deps.get
mix test          # uses .cache/zig-wasi/bin/talk.wasm
```

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
- **Values:** see `NorthTalk.Value`. Numbers are integers or `Decimal`s, and floats are refused. Text is UTF-8, normalised to NFC. A map is a `NorthTalk.Map`, in order; a plain map with at most one key is accepted on input.
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
- **Lost instances:** if the reactor is lost, the owner fails every waiting request with `instance lost` and stops, so its supervisor can restart it.

## Not offered

This Host speaks only part of the [Message Layer](../../spec/09-embedding.md#the-message-layer):

- **Host Objects** are not supported yet: a property need is refused, and every saved Host Object restores disposed.
- **Function Values** come with the full value set in [#993](https://github.com/odogono/odgn-talk/issues/993). They hold only a token, so nothing about them is durable on the Host's side.
- **Standard Capabilities** are not offered. The `sqlite` factory isn't offered through the Message Layer by any Host.
- **Revoke, cancellation, Broadcasts, Decisions, inspection, Fingerprints, Store Notification checkpoints, metering and the Host Manifest** have no Elixir API yet.

## The reactor

`NorthTalk.Artifact.path/0` looks for the reactor in this order:

1. The `NORTH_TALK_WASM` environment variable.
2. `config :north_talk, wasm_path: ...`.
3. The package's `priv/talk.wasm`.

The test configuration points at the repository's `.cache/` build.

## Layout

| Path | Contents |
| --- | --- |
| [`lib/north_talk.ex`](lib/north_talk.ex) | The public API. |
| [`lib/north_talk/owner.ex`](lib/north_talk/owner.ex) | The Instance Owner: exchanges, needs, Pumps and waiting requests. |
| [`lib/north_talk/capability.ex`](lib/north_talk/capability.ex) | Capabilities, Grants, and the `NorthTalk.Call`, `NorthTalk.Effect` and `NorthTalk.Release` a callback or hook gets. |
| [`lib/north_talk/group.ex`](lib/north_talk/group.ex) | Group and Library handles, and a restore's `NorthTalk.Restored` and `NorthTalk.PendingCall`s. |
| [`lib/north_talk/value.ex`](lib/north_talk/value.ex) | Value conversion. |
| [`lib/north_talk/transport.ex`](lib/north_talk/transport.ex) | The transport behaviour: one frame in, one frame out. |
| [`lib/north_talk/transport/wasi.ex`](lib/north_talk/transport/wasi.ex) | The reactor in Wasmex: compiling, instantiating, guest linear memory and `talk_buffer`/`talk_send`. |
| [`lib/north_talk/artifact.ex`](lib/north_talk/artifact.ex) | Where the reactor is found. |

The [Elixir benchmark Host](../../bench/message-layer/elixir/) measures this transport.
