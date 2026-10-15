# NorthTalk for Elixir

An Elixir embedding of NorthTalk, backed by the Zig Core's `wasm32-wasi` reactor in [Wasmex](https://hex.pm/packages/wasmex). It speaks the [Message Layer](../../spec/09-embedding.md#the-message-layer) and needs neither Go nor a sidecar. [#963](https://github.com/odogono/odgn-talk/issues/963) tracks the application-facing API. So far the package holds only the transport.

It supports Elixir 1.17 or later on OTP 27 or later, with Wasmex 0.15.1.

```sh
cd impl/zig && zig build -Dtarget=wasm32-wasi --prefix ../../.cache/zig-wasi
cd ../elixir
mix deps.get
mix test          # uses .cache/zig-wasi/bin/talk.wasm
```

## The reactor

`NorthTalk.Artifact.path/0` looks for the reactor in this order:

1. The `NORTH_TALK_WASM` environment variable.
2. `config :north_talk, wasm_path: ...`.
3. The package's `priv/talk.wasm`.

The test configuration points at the repository's `.cache/` build.

## Layout

| Path | Contents |
| --- | --- |
| [`lib/north_talk/transport.ex`](lib/north_talk/transport.ex) | The transport behaviour: one frame in, one frame out. |
| [`lib/north_talk/transport/wasi.ex`](lib/north_talk/transport/wasi.ex) | The reactor in Wasmex: compiling, instantiating, guest linear memory and `talk_buffer`/`talk_send`. |
| [`lib/north_talk/artifact.ex`](lib/north_talk/artifact.ex) | Where the reactor is found. |

The [Elixir benchmark Host](../../bench/message-layer/elixir/) measures this transport.
