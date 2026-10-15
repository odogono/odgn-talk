# NorthTalk for Elixir

An Elixir embedding of NorthTalk, backed by the Zig Core's `wasm32-wasi` reactor in [Wasmex](https://hex.pm/packages/wasmex). It speaks the [Message Layer](../../spec/09-embedding.md#the-message-layer) and needs neither Go nor a sidecar. [#963](https://github.com/odogono/odgn-talk/issues/963) tracks the rest of the application-facing API: Capabilities (#992), the full value set and Function Values (#993), lifecycle and save/restore (#994), a verified reactor release and fault recovery (#995).

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
- **Lost instances:** if the reactor is lost, the owner fails every waiting request with `instance lost` and stops, so its supervisor can restart it.

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
| [`lib/north_talk/value.ex`](lib/north_talk/value.ex) | Value conversion. |
| [`lib/north_talk/transport.ex`](lib/north_talk/transport.ex) | The transport behaviour: one frame in, one frame out. |
| [`lib/north_talk/transport/wasi.ex`](lib/north_talk/transport/wasi.ex) | The reactor in Wasmex: compiling, instantiating, guest linear memory and `talk_buffer`/`talk_send`. |
| [`lib/north_talk/artifact.ex`](lib/north_talk/artifact.ex) | Where the reactor is found. |

The [Elixir benchmark Host](../../bench/message-layer/elixir/) measures this transport.
