defmodule TalkHost.Transport.Wasi do
  @moduledoc """
  The Go Core's `wasip1` reactor in Wasmex. A frame is written into the
  buffer `talk_buffer(n)` gives, and `talk_send(n)` returns the reply packed
  as `ptr << 32 | len`.

  Options:

    * `:compiled` - `{engine, module}` from `compile/1`. Defaults to the
      reactor in the repository's `.cache/`, compiled once and cached.
    * `:opt_level` - Cranelift's optimization level when the default module
      is compiled: `:speed` (the default here) or `:none` (Wasmex's default).
    * `:memory_cap` - the most bytes linear memory may grow to, through
      `Wasmex.StoreLimits`. Unlimited by default.
    * `:timeout` - milliseconds for one export call, 60 s by default.
  """
  @behaviour TalkHost.Transport

  defstruct [:pid, :store, :memory, :stderr, :timeout]

  @doc """
  Compiles the reactor once. Returns `{{engine, module}, microseconds}`.
  Every instance of the module must use the same Engine.
  """
  def compile(path \\ TalkHost.Artifacts.wasm(), opt_level \\ :speed) do
    bytes = File.read!(path)
    {:ok, engine} = Wasmex.Engine.new(%Wasmex.EngineConfig{cranelift_opt_level: opt_level})
    {:ok, store} = Wasmex.Store.new(nil, engine)
    {micros, {:ok, module}} = :timer.tc(fn -> Wasmex.Module.compile(store, bytes) end)
    {{engine, module}, micros}
  end

  @impl true
  def start(opts \\ []) do
    {engine, module} = Keyword.get_lazy(opts, :compiled, fn -> cached(Keyword.get(opts, :opt_level, :speed)) end)
    limits = if cap = opts[:memory_cap], do: %Wasmex.StoreLimits{memory_size: cap}
    {:ok, stderr} = Wasmex.Pipe.new()
    {:ok, store} = Wasmex.Store.new_wasi(%Wasmex.Wasi.WasiOptions{stderr: stderr}, limits, engine)
    timeout = Keyword.get(opts, :timeout, 60_000)

    # Not linked: a lost instance is a result to record, not a crash here.
    with {:ok, pid} <- GenServer.start(Wasmex, %{store: store, module: module, imports: %{}, links: []}),
         {:ok, []} <- Wasmex.call_function(pid, "_initialize", [], timeout),
         {:ok, memory} <- Wasmex.memory(pid) do
      {:ok, %__MODULE__{pid: pid, store: store, memory: memory, stderr: stderr, timeout: timeout}}
    end
  end

  @impl true
  def exchange(%__MODULE__{} = t, frame) do
    n = byte_size(frame)

    with {:ok, [pointer]} when pointer != 0 <- call(t, "talk_buffer", [n]),
         :ok <- Wasmex.Memory.write_binary(t.store, t.memory, pointer, frame),
         {:ok, [packed]} <- call(t, "talk_send", [n]) do
      <<pointer::unsigned-32, length::unsigned-32>> = <<packed::signed-64>>
      {:ok, Wasmex.Memory.read_binary(t.store, t.memory, pointer, length)}
    else
      {:ok, [0]} -> {:refused, :null_buffer}
      {:error, _} = error -> error
    end
  end

  @doc "Sends `talk_send(n)` without a fresh buffer, for frames whose length lies."
  def send_length(%__MODULE__{} = t, n) do
    with {:ok, [packed]} <- call(t, "talk_send", [n]) do
      <<pointer::unsigned-32, length::unsigned-32>> = <<packed::signed-64>>
      {:ok, Wasmex.Memory.read_binary(t.store, t.memory, pointer, length)}
    end
  end

  @doc "Whatever the Go runtime wrote to stderr, such as a fatal error."
  def stderr(%__MODULE__{stderr: pipe}) do
    Wasmex.Pipe.seek(pipe, 0)
    Wasmex.Pipe.read(pipe)
  end

  @impl true
  def memory_bytes(%__MODULE__{store: store, memory: memory}),
    do: Wasmex.Memory.size(store, memory)

  @impl true
  def stop(%__MODULE__{pid: pid}) do
    if Process.alive?(pid), do: GenServer.stop(pid)
    :ok
  catch
    :exit, _ -> :ok
  end

  defp call(t, name, args) do
    if Process.alive?(t.pid),
      do: Wasmex.call_function(t.pid, name, args, t.timeout),
      else: {:error, :dead}
  catch
    :exit, reason -> {:error, {:exit, reason}}
  end

  defp cached(opt_level) do
    case :persistent_term.get({__MODULE__, opt_level}, nil) do
      nil ->
        {compiled, _} = compile(TalkHost.Artifacts.wasm(), opt_level)
        :persistent_term.put({__MODULE__, opt_level}, compiled)
        compiled

      compiled ->
        compiled
    end
  end
end
