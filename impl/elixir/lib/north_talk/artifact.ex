defmodule NorthTalk.Artifact do
  @moduledoc """
  Locates the Zig Core's `wasm32-wasi` reactor.

  In order: the `NORTH_TALK_WASM` environment variable, the `:wasm_path`
  application setting (`config :north_talk, wasm_path: ...`), then the
  package's `priv/talk.wasm`. A local build comes from
  `zig build -Dtarget=wasm32-wasi` in `impl/zig`.
  """

  @doc "The reactor's path. Raises when no file is there."
  def path do
    path =
      System.get_env("NORTH_TALK_WASM") ||
        Application.get_env(:north_talk, :wasm_path) ||
        Application.app_dir(:north_talk, "priv/talk.wasm")

    if File.regular?(path),
      do: path,
      else: raise("no NorthTalk reactor at #{path}; build one and set NORTH_TALK_WASM")
  end
end
