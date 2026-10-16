defmodule Mix.Tasks.Compile.NorthTalkReactor do
  @shortdoc "Fetches and verifies the pinned NorthTalk reactor into priv/"
  @moduledoc """
  Fetches the reactor release `NorthTalk.Artifact` pins into `priv/talk.wasm`
  and checks its SHA-256. It does nothing when `priv/talk.wasm` already
  matches, or when `NORTH_TALK_WASM` or `:wasm_path` overrides the reactor.
  """
  use Mix.Task.Compiler

  alias NorthTalk.Artifact

  @impl true
  def run(_args) do
    path = Artifact.priv_path()

    cond do
      Artifact.override() ->
        {:noop, []}

      is_nil(Artifact.sha256()) ->
        Mix.shell().info("north_talk: no reactor is pinned yet; set NORTH_TALK_WASM")
        {:noop, []}

      File.regular?(path) and Artifact.digest(File.read!(path)) == Artifact.sha256() ->
        {:noop, []}

      true ->
        fetch!(path)
        {:ok, []}
    end
  end

  defp fetch!(path) do
    Mix.shell().info("north_talk: fetching #{Artifact.url()}")
    bytes = download!(Artifact.url())
    digest = Artifact.digest(bytes)

    if digest != Artifact.sha256(),
      do: Mix.raise("#{Artifact.url()} has SHA-256 #{digest}, not the pinned #{Artifact.sha256()}")

    File.mkdir_p!(Path.dirname(path))
    tmp = path <> ".part"
    File.write!(tmp, bytes)
    File.rename!(tmp, path)
  end

  defp download!(url) do
    {:ok, _} = Application.ensure_all_started([:inets, :ssl])

    ssl = [
      verify: :verify_peer,
      cacerts: :public_key.cacerts_get(),
      customize_hostname_check: [match_fun: :public_key.pkix_verify_hostname_match_fun(:https)]
    ]

    case :httpc.request(:get, {String.to_charlist(url), []}, [ssl: ssl, autoredirect: true], body_format: :binary) do
      {:ok, {{_, 200, _}, _, body}} -> body
      other -> Mix.raise("could not fetch #{url}: #{inspect(other)}")
    end
  end
end
