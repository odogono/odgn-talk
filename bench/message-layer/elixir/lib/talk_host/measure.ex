defmodule TalkHost.Measure do
  @moduledoc """
  The latency, instantiation and memory figures #532 sets thresholds for.

  Each latency figure warms up, then takes at least `:samples` samples, and
  runs three times. It is judged on the run with the median p50, since the
  message-layer research saw up to 2× variance between runs.
  """
  alias TalkHost.{Session, Transport}

  @now "2026-10-10T12:00:00Z"
  @calls_per_pump 100

  @calls_source """
  on calls n
    repeat for each i in 1..n
      ask api to echo {items: [i, "hello", true], count: 1}
    end repeat
  end calls
  """

  @ping_source """
  on ping
  end ping
  """

  @doc """
  The time from the Host receiving one `op` need to receiving the next, with
  the handler answering at once with its argument. It covers encoding the
  `op-result`, both crossings, the Core charging and resuming the Run, one
  loop iteration, and decoding the next `op`, whose argument is a small Map
  in the Value Encoding.
  """
  def capability_call(start, opts) do
    runs(opts, fn samples ->
      session = setup(start, @calls_source, ops: %{"echo" => &echo/1})
      warm = div(opts[:warmup], @calls_per_pump) + 1
      pumps = div(samples, @calls_per_pump - 1) + 1

      {session, _} = Enum.reduce(1..warm, {session, []}, fn _, acc -> call_pump(acc) end)
      {session, intervals} = Enum.reduce(1..pumps, {session, []}, fn _, acc -> call_pump(acc) end)
      Transport.stop(session.transport)
      intervals
    end)
  end

  defp echo(%{"args" => [x]}) do
    Process.put(:op_times, [System.monotonic_time(:nanosecond) | Process.get(:op_times, [])])
    %{"result" => x, "charged" => 0}
  end

  defp call_pump({session, acc}) do
    Process.put(:op_times, [])
    message = %{"name" => "calls", "args" => [@calls_per_pump]}
    {session, _} = Session.ok!(session, "deliver", %{"group" => "g", "to" => %{"script" => "s"}, "message" => message})
    {session, pump} = Session.ok!(session, "pump", %{"group" => "g", "now" => @now})
    [%{"outcome" => "completed"}] = Session.run_ends(pump)
    times = Process.get(:op_times) |> Enum.reverse()
    true = length(times) == @calls_per_pump
    intervals = times |> Enum.chunk_every(2, 1, :discard) |> Enum.map(fn [a, b] -> (b - a) / 1000 end)
    {session, intervals ++ acc}
  end

  @doc "A `deliver` and then a `pump` of a Handler with no Operations, until its `run end`."
  def pump(start, opts) do
    runs(opts, fn samples ->
      session = setup(start, @ping_source, [])
      {session, _} = Enum.reduce(1..opts[:warmup], {session, []}, fn _, acc -> ping(acc) end)
      {session, times} = Enum.reduce(1..samples, {session, []}, fn _, acc -> ping(acc) end)
      Transport.stop(session.transport)
      times
    end)
  end

  defp ping({session, acc}) do
    t0 = System.monotonic_time(:nanosecond)

    {session, _} =
      Session.ok!(session, "deliver", %{"group" => "g", "to" => %{"script" => "s"}, "message" => %{"name" => "ping"}})

    {session, pump} = Session.ok!(session, "pump", %{"group" => "g", "now" => @now})
    t1 = System.monotonic_time(:nanosecond)
    [%{"outcome" => "completed"}] = Session.run_ends(pump)
    {session, [(t1 - t0) / 1000 | acc]}
  end

  @doc """
  From a compiled module (WASI) or process spawn (sidecar) to the `hello`
  reply, in microseconds.
  """
  def instantiation(start, opts) do
    runs(opts, fn samples ->
      Enum.each(1..opts[:warmup_instances], fn _ -> instantiate(start) end)
      Enum.map(1..samples, fn _ -> instantiate(start) end)
    end)
  end

  defp instantiate(start) do
    t0 = System.monotonic_time(:nanosecond)
    {:ok, t} = start.()
    {_, %{"ok" => _}} = Session.request(Session.new(t), "hello", %{"protocol" => 1})
    t1 = System.monotonic_time(:nanosecond)
    Transport.stop(t)
    (t1 - t0) / 1000
  end

  @doc "Memory per instance after `hello`, loading a small Script and one Pump."
  def memory(start, count) do
    bytes =
      Enum.map(1..count, fn _ ->
        session = setup(start, @ping_source, [])
        {session, _} = ping({session, []})
        bytes = Transport.memory_bytes(session.transport)
        Transport.stop(session.transport)
        bytes
      end)

    %{"instances" => count, "medianBytes" => median(bytes), "maxBytes" => Enum.max(bytes)}
  end

  @doc "Starts an instance and loads `source` as Script `s` in Group `g`, with an `api` Grant."
  def setup(start, source, session_opts, limits \\ %{}) do
    {:ok, t} = start.()
    s = Session.new(t, session_opts)
    {s, _} = Session.ok!(s, "hello", %{"protocol" => 1})

    {s, _} =
      Session.ok!(s, "define-capability", %{
        "name" => "api",
        "ops" => [
          %{"name" => "echo", "mode" => "immediate", "args" => ["any"], "result" => "any", "cost" => %{"fuel" => 1}}
        ]
      })

    {s, %{"grant" => grant}} = Session.ok!(s, "grant", %{"capability" => "api", "ops" => "all"})
    {s, _} = Session.ok!(s, "new-group", %{"group" => "g", "name" => "g"})

    {s, _} =
      Session.ok!(s, "load", %{
        "group" => "g",
        "name" => "s",
        "grants" => %{"api" => grant},
        "source" => source,
        "limits" => limits
      })

    s
  end

  defp runs(opts, sample) do
    runs =
      Enum.map(1..opts[:runs], fn _ ->
        :erlang.garbage_collect()
        summarize(sample.(opts[:samples]))
      end)

    chosen = runs |> Enum.sort_by(& &1["p50"]) |> Enum.at(div(length(runs), 2))
    Map.put(chosen, "runs", runs)
  end

  @doc "p50, p99, mean, min and max of samples in microseconds."
  def summarize(samples) do
    sorted = Enum.sort(samples)
    n = length(sorted)

    %{
      "n" => n,
      "p50" => round1(percentile(sorted, n, 0.50)),
      "p99" => round1(percentile(sorted, n, 0.99)),
      "mean" => round1(Enum.sum(sorted) / n),
      "min" => round1(hd(sorted)),
      "max" => round1(List.last(sorted))
    }
  end

  defp percentile(sorted, n, p), do: Enum.at(sorted, min(n - 1, ceil(p * n) - 1))
  defp median(xs), do: xs |> Enum.sort() |> Enum.at(div(length(xs), 2))
  defp round1(x), do: Float.round(x / 1, 1)
end
