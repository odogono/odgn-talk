import Config

# Tests in this repository use the reactor `zig build -Dtarget=wasm32-wasi
# --prefix ../../.cache/zig-wasi` writes in impl/zig.
if config_env() == :test do
  config :north_talk, wasm_path: Path.expand("../../../.cache/zig-wasi/bin/talk.wasm", __DIR__)
end
