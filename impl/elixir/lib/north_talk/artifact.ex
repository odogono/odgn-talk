defmodule NorthTalk.Artifact do
  @moduledoc """
  Locates and verifies the Zig Core's `wasm32-wasi` reactor.

  In order: the `NORTH_TALK_WASM` environment variable, the `:wasm_path`
  application setting (`config :north_talk, wasm_path: ...`), then the
  package's `priv/talk.wasm`. A local build comes from
  `zig build -Dtarget=wasm32-wasi` in `impl/zig`.

  The package pins one reactor release: its tag and SHA-256. `mix compile`
  fetches it into `priv/` and verifies it (`Mix.Tasks.Compile.NorthTalkReactor`),
  so a consumer needs neither Go nor Zig. `priv/talk.wasm` is verified against
  the pin again before it is compiled; an override is the caller's own and is
  only hashed, to key the compiled-module cache.
  """

  # The release CI's `Elixir reactor` workflow published, and its digest.
  @release "reactor-v0.6.1"
  @sha256 "0184913374bec3261cc6e6079e349929fa14aa76608044145f24e0c38b91b68f"
  @repository "odogono/odgn-talk"

  # What this Host reads: the save format it was written against, and the
  # `hello` features it requires.
  @save_format "zig/13"
  @required_features []

  def release, do: @release
  def sha256, do: @sha256
  def url, do: "https://github.com/#{@repository}/releases/download/#{@release}/talk.wasm"
  def save_format, do: @save_format
  def required_features, do: @required_features

  @doc "The packaged reactor's path, whether or not it is there."
  def priv_path, do: Application.app_dir(:north_talk, "priv/talk.wasm")

  @doc "The reactor's path. Raises when no file is there."
  def path do
    path = override() || priv_path()

    if File.regular?(path),
      do: path,
      else: raise("no NorthTalk reactor at #{path}; run mix compile, or set NORTH_TALK_WASM")
  end

  @doc "The reactor the caller gave, if any: `NORTH_TALK_WASM`, then `:wasm_path`."
  def override, do: System.get_env("NORTH_TALK_WASM") || Application.get_env(:north_talk, :wasm_path)

  @doc """
  Reads the reactor at `path` and returns `{bytes, digest}`, digest as
  lowercase hex. The packaged reactor must match the pin.
  """
  def read!(path) do
    bytes = File.read!(path)
    digest = digest(bytes)

    if path == priv_path() and digest != @sha256,
      do: raise("#{path} has SHA-256 #{digest}, not the pinned #{inspect(@sha256)}; run mix compile again")

    {bytes, digest}
  end

  def digest(bytes), do: :crypto.hash(:sha256, bytes) |> Base.encode16(case: :lower)
end
