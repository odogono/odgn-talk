defmodule TalkHost.Transport.Bridge do
  @moduledoc """
  The minimal C Host's `--serve` mode ([`bench/message-layer-c`](../../../../../message-layer-c/)):
  one `wasip1` instance in the wasmtime C API, carried over stdin and stdout in
  the sidecar's framing. It lets the fault and containment suites judge the C
  Host's row of #532 with the same cases as the Elixir transports. Latency is
  measured inside the C Host instead, since the Port would add to it.

  Options:

    * `:memory_cap` - the most bytes linear memory may grow to, through the
      Store's limiter. wasm32's 4 GiB by default.
    * `:timeout` - milliseconds to wait for one reply, 60 s by default.
  """
  @behaviour TalkHost.Transport

  alias TalkHost.Transport.Sidecar

  defstruct [:sidecar, :memory]

  @impl true
  def start(opts \\ []) do
    memory = Path.join(System.tmp_dir!(), "talk-bridge-#{System.unique_integer([:positive])}.memory")
    command = [TalkHost.Artifacts.c_host(), "--serve", TalkHost.Artifacts.wasm(), "#{opts[:memory_cap] || 0}"]

    # The shell passes TALK_MEMORY on, where the bridge keeps linear memory's size.
    command = ["/usr/bin/env", "TALK_MEMORY=#{memory}" | command]
    {:ok, sidecar} = Sidecar.start(command: command, timeout: Keyword.get(opts, :timeout, 60_000))
    {:ok, %__MODULE__{sidecar: sidecar, memory: memory}}
  end

  @impl true
  def exchange(%__MODULE__{sidecar: s}, frame) do
    case Sidecar.exchange(s, frame) do
      {:ok, ~s({"refused":"null_buffer"})} -> {:refused, :null_buffer}
      other -> other
    end
  end

  @doc "Whatever the bridge wrote to stderr: the Go runtime's fatal error, or a wasmtime trap."
  def stderr(%__MODULE__{sidecar: s}), do: Sidecar.stderr(s)

  @doc "Linear memory, as the bridge last recorded it, including just before a trap."
  @impl true
  def memory_bytes(%__MODULE__{memory: path}) do
    case File.read(path) do
      {:ok, text} -> text |> String.trim() |> String.to_integer()
      {:error, _} -> 0
    end
  end

  @impl true
  def stop(%__MODULE__{sidecar: s, memory: path}) do
    Sidecar.stop(s)
    File.rm(path)
    :ok
  end
end
