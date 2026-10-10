defmodule TalkHost.Transport.Sidecar do
  @moduledoc """
  The Go Core's sidecar on an Erlang Port. `{:packet, 4}` is exactly the
  sidecar's framing: a 4-byte big-endian length, then the JSON.

  Options:

    * `:command` - the executable and its arguments, `[path | args]`.
      Defaults to the native sidecar in the repository's `.cache/`.
    * `:timeout` - milliseconds to wait for one reply, 60 s by default.
  """
  @behaviour TalkHost.Transport

  defstruct [:port, :os_pid, :timeout, :stderr]

  # The calling process traps exits, so a sidecar that dies under a write
  # comes back as a lost instance rather than an `:epipe` exit signal.
  @impl true
  def start(opts \\ []) do
    Process.flag(:trap_exit, true)
    [exe | args] = Keyword.get_lazy(opts, :command, fn -> [TalkHost.Artifacts.sidecar()] end)
    exe = System.find_executable(exe) || exe
    stderr = Path.join(System.tmp_dir!(), "talk-sidecar-#{System.unique_integer([:positive])}.stderr")

    # The shell only redirects stderr, so a fatal error can be read back.
    port =
      Port.open({:spawn_executable, "/bin/sh"}, [
        :binary,
        {:packet, 4},
        :exit_status,
        args: ["-c", ~s(exec "$0" "$@" 2>"$TALK_STDERR"), exe | args],
        env: [{~c"TALK_STDERR", String.to_charlist(stderr)}]
      ])

    {:os_pid, os_pid} = Port.info(port, :os_pid)
    {:ok, %__MODULE__{port: port, os_pid: os_pid, timeout: Keyword.get(opts, :timeout, 60_000), stderr: stderr}}
  end

  @doc "Whatever the sidecar wrote to stderr, such as a fatal error."
  def stderr(%__MODULE__{stderr: path}) do
    case File.read(path) do
      {:ok, text} -> text
      {:error, _} -> ""
    end
  end

  @impl true
  def exchange(%__MODULE__{port: port, timeout: timeout}, frame) do
    Port.command(port, frame)

    receive do
      {^port, {:data, reply}} -> {:ok, reply}
      {^port, {:exit_status, status}} -> {:error, {:exit_status, status}}
      {:EXIT, ^port, reason} -> {:error, {:exit, reason}}
    after
      timeout -> {:error, :timeout}
    end
  rescue
    ArgumentError -> {:error, :closed}
  end

  @impl true
  def memory_bytes(%__MODULE__{os_pid: os_pid}) do
    {out, 0} = System.cmd("ps", ["-o", "rss=", "-p", Integer.to_string(os_pid)])
    String.to_integer(String.trim(out)) * 1024
  end

  # Closing the Port only closes the sidecar's stdin, which a sidecar stuck
  # in a long Load never reads, so the process is killed as well.
  @impl true
  def stop(%__MODULE__{port: port, os_pid: os_pid, stderr: stderr}) do
    if Port.info(port), do: Port.close(port)
    System.cmd("kill", ["-9", Integer.to_string(os_pid)], stderr_to_stdout: true)
    File.rm(stderr)

    receive do
      {^port, {:exit_status, _}} -> :ok
    after
      0 -> :ok
    end

    receive do
      {:EXIT, ^port, _} -> :ok
    after
      0 -> :ok
    end
  rescue
    ArgumentError -> :ok
  end
end
