defmodule NorthTalk.RequestPumpTest do
  use ExUnit.Case, async: true
  alias NorthTalk.{Binary, HostError, Pending, Pumped, Result, ScriptError, Transport}

  # A real reactor whose frames are observed, and which can hide the binary
  # feature as an older Core would.
  defmodule Reactor do
    @behaviour Transport
    defstruct [:wasm, :observer, :hide]

    @impl true
    def start(opts) do
      {:ok, wasm} = Transport.Wasi.start(Keyword.drop(opts, [:observer, :hide]))
      {:ok, %__MODULE__{wasm: wasm, observer: opts[:observer], hide: opts[:hide]}}
    end

    @impl true
    def exchange(t, bytes) do
      binary? = Binary.binary?(bytes)
      frame = if binary?, do: Binary.decode(bytes), else: Jason.decode!(bytes, objects: :ordered_objects)
      {:ok, reply} = Transport.exchange(t.wasm, bytes)
      send(t.observer, {:frame, frame["m"], binary?, Binary.binary?(reply)})

      if t.hide == true and frame["m"] == "hello" do
        reply = Jason.decode!(reply)
        {:ok, Jason.encode!(update_in(reply, ["ok", "features"], &(&1 -- [Binary.feature()])))}
      else
        {:ok, reply}
      end
    end

    @impl true
    def memory_bytes(t), do: Transport.memory_bytes(t.wasm)
    @impl true
    def stop(t), do: Transport.stop(t.wasm)
  end

  defmodule Api do
    use NorthTalk.Capability, name: "api"

    operation("double", args: ["number"], result: "number", cost: 1)

    def double([n], call) do
      send(call.binding, {:double, n})
      {:ok, n * 2}
    end
  end

  @source """
  on plus a, b
    return a + b
  end plus

  on echo v
    return v
  end echo

  on boom
    return 1 / 0
  end boom

  on adder n
    return given x: x + n
  end adder

  on twice n
    ask api to double n
    return it
  end twice

  on spin n
    put 0 into total
    repeat for each i in 1..n
      put total + i into total
    end repeat
    return total
  end spin
  """

  @t0 ~U[2026-10-18 12:00:00Z]

  defp start(opts) do
    {:ok, owner} = NorthTalk.start_link([transport: Reactor, observer: self(), reports_to: self()] ++ opts)
    :ok = NorthTalk.define_capability!(owner, Api)
    grant = NorthTalk.grant!(owner, "api", binding: self())
    group = NorthTalk.new_group!(owner, "g", [])
    "s" = NorthTalk.load!(group, "s", @source, grants: %{"api" => grant})
    {owner, group}
  end

  test "a combined request admits and Pumps once in binary frames, under manual drive" do
    {_, group} = start(drive: :manual)

    assert {:ok, %Pumped{pending: %Pending{delivery: "d" <> _} = pending, pump: {:ok, pump}}} =
             NorthTalk.request_pump(group, "s", "plus", [1, Decimal.new("2.50")], now: @t0)

    assert_receive {:frame, "request-pump", true, true}
    assert %{state: "idle", reports: reports} = pump
    assert Enum.any?(reports, &match?(%{"kind" => "run end", "outcome" => "completed"}, &1))

    assert {:ok, %Result{value: value, delivery: delivery}} = NorthTalk.await(pending)
    assert delivery == pending.delivery and Decimal.to_string(value) == "3.50"
    # Awaiting again returns the retained result.
    assert {:ok, %Result{value: ^value}} = NorthTalk.await(pending, 0)
  end

  test "a callback's need and answer stay JSON inside the combined exchange" do
    {_, group} = start(drive: :manual)
    assert {:ok, %Pumped{pending: pending}} = NorthTalk.request_pump(group, "s", "twice", [21], now: @t0)
    assert_receive {:double, 21}
    assert_receive {:frame, "request-pump", true, false}
    assert_receive {:frame, "op-result", false, true}
    assert {:ok, %Result{value: 42}} = NorthTalk.await(pending)
  end

  test "earlier inputs run first, and the Run may outlast the one Pump" do
    {_, group} = start(drive: :manual, fuel_slice: 200)
    {:ok, earlier} = NorthTalk.deliver(group, "s", "plus", [1, 1])

    assert {:ok, %Pumped{pending: pending, pump: {:ok, %{state: "sliced", reports: reports}}}} =
             NorthTalk.request_pump(group, "s", "spin", [10_000], now: @t0)

    assert Enum.any?(reports, &match?(%{"kind" => "run end", "delivery" => ^earlier}, &1))
    # An await timeout leaves the Run going.
    assert {:error, %HostError{code: "timeout"}} = NorthTalk.await(pending, 10)

    awaiter = Task.async(fn -> NorthTalk.await(pending, 5_000) end)
    pump_until_idle(group)
    assert {:ok, %Result{value: 50_005_000}} = Task.await(awaiter)
    assert {:ok, %Result{value: 50_005_000}} = NorthTalk.await(pending)
  end

  test "an automatic owner Pumps on after the combined Pump" do
    {_, group} = start(fuel_slice: 200)

    assert {:ok, %Pumped{pending: pending, pump: {:ok, %{state: "sliced"}}}} =
             NorthTalk.request_pump(group, "s", "spin", [10_000])

    assert {:ok, %Result{value: 50_005_000}} = NorthTalk.await(pending)
  end

  test "an admission refusal has no handle and no Pump" do
    {_, group} = start(drive: :manual)
    assert {:error, %HostError{code: "invalid value"}} = NorthTalk.request_pump(group, "missing", "plus", [1, 2])
    assert {:error, %HostError{code: "invalid value"}} = NorthTalk.request_pump(group, "s", "plus", [1.5, 2])
    refute_received {:north_talk, _, _}
    assert {:ok, %{reports: []}} = NorthTalk.pump(group, now: @t0)
  end

  test "a refused Pump keeps the handle and leaves the request queued" do
    {_, group} = start(drive: :manual)
    {:ok, _} = NorthTalk.pump(group, now: @t0)

    assert {:ok, %Pumped{pending: pending, pump: {:error, %HostError{code: "clock backwards"}}}} =
             NorthTalk.request_pump(group, "s", "plus", [2, 3], now: ~U[2026-10-18 11:00:00Z])

    assert {:error, %HostError{code: "timeout"}} = NorthTalk.await(pending, 0)
    assert {:ok, %{reports: reports}} = NorthTalk.pump(group, now: @t0)
    assert Enum.any?(reports, &match?(%{"kind" => "run end", "delivery" => _}, &1))
    assert {:ok, %Result{value: 5}} = NorthTalk.await(pending)
  end

  test "a failing Run is a ScriptError on every await" do
    {_, group} = start(drive: :manual)
    {:ok, %Pumped{pending: pending}} = NorthTalk.request_pump(group, "s", "boom", [], now: @t0)
    assert {:error, %ScriptError{outcome: "errored"}} = NorthTalk.await(pending)
    assert {:error, %ScriptError{outcome: "errored"}} = NorthTalk.await(pending)
  end

  test "release fails awaiters, now and later, without cancelling the request" do
    {_, group} = start(drive: :manual)
    {:ok, %Pumped{pending: pending}} = NorthTalk.request_pump(group, "s", "plus", [1, 2], now: @t0)
    :ok = NorthTalk.release_pending(pending)
    assert {:error, %HostError{code: "pending released"}} = NorthTalk.await(pending)

    {:ok, _} = NorthTalk.pump(group, now: @t0)
    {:ok, %Pumped{pending: queued, pump: {:error, _}}} = refused(group)
    awaiter = Task.async(fn -> NorthTalk.await(queued, 5_000) end)
    wait_for_awaiter(queued)
    :ok = NorthTalk.release_pending(queued)
    assert {:error, %HostError{code: "pending released"}} = Task.await(awaiter)
    assert :ok = NorthTalk.release_pending(queued)

    # The released request still runs.
    delivery = queued.delivery
    {:ok, _} = NorthTalk.pump(group, now: @t0)
    assert_received {:north_talk, _, %{"kind" => "run end", "delivery" => ^delivery, "outcome" => "completed"}}
  end

  test "closing the Group releases its handles" do
    {_, group} = start(drive: :manual)
    {:ok, _} = NorthTalk.pump(group, now: @t0)
    {:ok, %Pumped{pending: pending}} = refused(group)
    awaiter = Task.async(fn -> NorthTalk.await(pending, 5_000) end)
    wait_for_awaiter(pending)
    :ok = NorthTalk.close_group(group)
    assert {:error, %HostError{code: "group closed"}} = Task.await(awaiter)
    assert {:error, %HostError{code: "pending released"}} = NorthTalk.await(pending)
    assert {:error, %HostError{code: "group closed"}} = NorthTalk.request_pump(group, "s", "plus", [1, 2])
  end

  test "call_pump calls a Function Value; arity errors belong to its Run" do
    {_, group} = start(drive: :manual)
    {:ok, %Result{value: add2}} = request(group, "adder", [2])

    assert {:ok, %Pumped{pending: pending, pump: {:ok, _}}} = NorthTalk.call_pump(group, add2, [3], now: @t0)
    assert_receive {:frame, "call-pump", true, true}
    assert {:ok, %Result{value: 5}} = NorthTalk.await(pending)

    assert {:ok, %Pumped{pending: wrong}} = NorthTalk.call_pump(group, add2, [1, 2], now: @t0)
    assert {:error, %ScriptError{}} = NorthTalk.await(wrong)

    :ok = NorthTalk.release(add2)
    assert {:error, %HostError{code: "function released"}} = NorthTalk.call_pump(group, add2, [3])
  end

  test "values cross the binary envelope both ways" do
    {_, group} = start(drive: :manual)

    for value <- [
          nil,
          true,
          9_007_199_254_740_993,
          -18_446_744_073_709_551_615,
          123_456_789_012_345_678_901_234_567_890,
          Decimal.new("-0.50"),
          Decimal.new("0.0"),
          "é",
          NorthTalk.Bytes.new(<<0, 255>>),
          [1, ["x", []]],
          NorthTalk.Map.new([{"z", 1}, {"$a", NorthTalk.Map.new([{"k", 2}])}]),
          NorthTalk.Quantity.new(Decimal.new("2.50"), "GBP"),
          NorthTalk.Range.new(1, 5),
          %NorthTalk.Instant{unix_us: -1_704_164_645_123_456},
          %NorthTalk.CivilDate{year: 2024, month: 1, day: 2},
          NorthTalk.Pattern.new(~s(<"ID-", 4 digits>))
        ] do
      {:ok, %Pumped{pending: pending}} = NorthTalk.request_pump(group, "s", "echo", [value], now: @t0)
      expected = if value == "é", do: "é", else: value
      assert {:ok, %Result{value: ^expected}} = NorthTalk.await(pending)
    end

    # The Zig reader stops at magnitude 2^64 - 1; the spec allows 2^64 (#1274). Its
    # refusal of the frame changes nothing.
    assert {:error, %HostError{code: "protocol error"}} =
             NorthTalk.request_pump(group, "s", "echo", [-18_446_744_073_709_551_616], now: @t0)

    deep = Enum.reduce(1..5_000, 0, fn _, v -> [v] end)
    {:ok, %Pumped{pending: pending}} = NorthTalk.request_pump(group, "s", "echo", [deep], now: @t0)
    assert {:ok, %Result{value: ^deep}} = NorthTalk.await(pending)
  end

  test "a guest without the feature refuses combined calls before admission" do
    {owner, group} = start(drive: :manual, hide: true)
    refute Binary.feature() in NorthTalk.versions(owner)["features"]

    assert {:error, %HostError{code: "invalid value", detail: "talk.wasm lacks request-pump-fields-v1"}} =
             NorthTalk.request_pump(group, "s", "plus", [1, 2])

    refute_received {:frame, "request-pump", _, _}
    assert {:ok, %{reports: []}} = NorthTalk.pump(group, now: @t0)
    task = Task.async(fn -> NorthTalk.request(group, "s", "plus", [1, 2]) end)
    Process.sleep(50)
    {:ok, _} = NorthTalk.pump(group, now: @t0)
    assert {:ok, %Result{value: 3}} = Task.await(task)
  end

  defp request(group, name, args) do
    task = Task.async(fn -> NorthTalk.request(group, "s", name, args) end)
    Process.sleep(50)
    {:ok, _} = NorthTalk.pump(group, now: @t0)
    Task.await(task)
  end

  defp refused(group),
    do: NorthTalk.request_pump(group, "s", "plus", [1, 2], now: ~U[2026-10-18 11:00:00Z])

  defp pump_until_idle(group) do
    case NorthTalk.pump(group, now: @t0) do
      {:ok, %{state: "sliced"}} -> pump_until_idle(group)
      {:ok, _} -> :ok
    end
  end

  defp wait_for_awaiter(%Pending{owner: owner, id: id} = pending) do
    if map_size(:sys.get_state(owner).handles[id].awaiters) == 0 do
      Process.sleep(5)
      wait_for_awaiter(pending)
    end
  end
end
