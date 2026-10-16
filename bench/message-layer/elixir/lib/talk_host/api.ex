defmodule TalkHost.Api do
  @moduledoc """
  The same figures through the Elixir embedding's public API, `NorthTalk`,
  rather than raw frames: what an application pays for the Instance Owner,
  value conversion and callback Tasks on top of the transport.
  """
  alias NorthTalk.{Capability, Result}
  alias TalkHost.Measure

  @calls_per_request 100

  @source """
  on ping
  end ping

  on calls n
    repeat for each i in 1..n
      ask api to echo {items: [i, "hello", true], count: 1}
    end repeat
  end calls

  on later
    ask api to later and wait
    return it
  end later
  """

  @doc """
  `request/5` of an empty Handler, from the call to its result, with the
  owner Pumping automatically.
  """
  def request(opts) do
    Measure.runs(opts, fn samples ->
      {owner, group} = setup()
      for _ <- 1..opts[:warmup], do: {:ok, _} = NorthTalk.request(group, "s", "ping")

      times =
        for _ <- 1..samples do
          t0 = System.monotonic_time(:nanosecond)
          {:ok, %Result{}} = NorthTalk.request(group, "s", "ping")
          (System.monotonic_time(:nanosecond) - t0) / 1000
        end

      NorthTalk.close(owner)
      times
    end)
  end

  @doc """
  The time from one immediate callback starting to the next, inside one
  Request of 100 calls. Each callback runs in its own Task, and answers at
  once with its argument.
  """
  def callback(opts) do
    Measure.runs(opts, fn samples ->
      {owner, group} = setup()
      requests = div(samples, @calls_per_request - 1) + 1
      warm = div(opts[:warmup], @calls_per_request) + 1
      for _ <- 1..warm, do: calls(group)
      intervals = Enum.flat_map(1..requests, fn _ -> calls(group) end)
      NorthTalk.close(owner)
      intervals
    end)
  end

  defp calls(group) do
    :ets.delete_all_objects(:talk_host_api)
    {:ok, _} = NorthTalk.request(group, "s", "calls", [@calls_per_request])
    times = :ets.tab2list(:talk_host_api) |> Enum.map(&elem(&1, 0)) |> Enum.sort()
    true = length(times) == @calls_per_request
    times |> Enum.chunk_every(2, 1, :discard) |> Enum.map(fn [a, b] -> (b - a) / 1000 end)
  end

  @doc """
  A Request whose Handler waits on a suspending Operation that defers, then
  is answered with `answer/3` from another process.
  """
  def deferred(opts) do
    Measure.runs(opts, fn samples ->
      {owner, group} = setup()
      for _ <- 1..opts[:warmup], do: {:ok, _} = NorthTalk.request(group, "s", "later")

      times =
        for _ <- 1..samples do
          t0 = System.monotonic_time(:nanosecond)
          {:ok, %Result{value: "done"}} = NorthTalk.request(group, "s", "later")
          (System.monotonic_time(:nanosecond) - t0) / 1000
        end

      NorthTalk.close(owner)
      times
    end)
  end

  @doc """
  Per owner, after a Group, the Script above and one Request: guest linear
  memory, and the owner process's own heap, which linear memory isn't in.
  """
  def memory(count) do
    figures =
      for _ <- 1..count do
        {owner, group} = setup()
        {:ok, _} = NorthTalk.request(group, "s", "ping")
        %{linear: linear} = NorthTalk.memory(owner)
        {:memory, process} = Process.info(owner, :memory)
        NorthTalk.close(owner)
        {linear, process}
      end

    %{
      "owners" => count,
      "linearMedianBytes" => median(Enum.map(figures, &elem(&1, 0))),
      "processMedianBytes" => median(Enum.map(figures, &elem(&1, 1)))
    }
  end

  defp setup do
    if :ets.whereis(:talk_host_api) == :undefined,
      do: :ets.new(:talk_host_api, [:public, :named_table, :duplicate_bag])

    {:ok, owner} = NorthTalk.start_link(path: TalkHost.Artifacts.wasm())
    Process.unlink(owner)

    echo = fn [x], _call ->
      :ets.insert(:talk_host_api, {System.monotonic_time(:nanosecond)})
      {:ok, x}
    end

    later = fn [], call ->
      ref = make_ref()
      spawn(fn -> answer(call.owner, ref) end)
      {:defer, ref}
    end

    api =
      Capability.from_functions("api", %{
        "echo" => {[args: ["any"], cost: 1], echo},
        "later" => {[mode: :suspending, result: "text", cost: 1], later}
      })

    :ok = NorthTalk.define_capability!(owner, api)
    grant = NorthTalk.grant!(owner, "api")
    group = NorthTalk.new_group!(owner, "g", [])
    "s" = NorthTalk.load!(group, "s", @source, grants: %{"api" => grant})
    {owner, group}
  end

  # The owner records the ref once this callback returns, so an answer can
  # arrive first.
  defp answer(owner, ref) do
    case NorthTalk.answer(owner, ref, "done") do
      :ok -> :ok
      {:error, :unknown_ref} -> answer(owner, ref)
    end
  end

  defp median(xs), do: xs |> Enum.sort() |> Enum.at(div(length(xs), 2))
end
