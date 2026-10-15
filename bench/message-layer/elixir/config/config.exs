import Config

# The library loads the reactor this Host measures (TalkHost.Artifacts.wasm/0).
config :north_talk,
  wasm_path: System.get_env("TALK_WASM") || Path.expand("../../../../.cache/zig-wasi/bin/talk.wasm", __DIR__)
