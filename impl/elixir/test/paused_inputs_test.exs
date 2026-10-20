defmodule NorthTalk.PausedInputsTest do
  use ExUnit.Case, async: true
  alias NorthTalk.{Capability, HostError, Transport}

  # The real reactor, which can hide hello features and reports each frame.
  defmodule Reactor do
    @behaviour Transport
    defstruct [:wasm, :observer, :hide]

    @impl true
    def start(opts) do
      {:ok, wasm} = Transport.Wasi.start([])
      {:ok, %__MODULE__{wasm: wasm, observer: opts[:observer], hide: opts[:hide] || []}}
    end

    @impl true
    def exchange(t, bytes) do
      frame = NorthTalk.TestWire.decode(bytes)
      {:ok, reply} = Transport.exchange(t.wasm, bytes)
      if t.observer, do: send(t.observer, {:frame, frame["m"], frame["ref"], frame["features"]})

      if frame["m"] == "hello" do
        reply = Jason.decode!(reply)
        {:ok, Jason.encode!(update_in(reply, ["ok", "features"], &(&1 -- t.hide)))}
      else
        {:ok, reply}
      end
    end

    @impl true
    def memory_bytes(t), do: Transport.memory_bytes(t.wasm)
    @impl true
    def stop(t), do: Transport.stop(t.wasm)
  end

  @source """
  on go
    ask api to halt
    send done to log
  end go
  """

  @log """
  on note n
  end note
  on done
  end done
  """

  # `halt` runs `fun` inside its callback and sends the test what it got.
  # Its Segment's crossings go to the test as well.
  defp start(fun, opts \\ []) do
    test = self()

    halt = fn [], call ->
      send(test, {:callback, fun.(call)})
      {:ok, nil}
    end

    effect = fn phase, _ ->
      send(test, {:effect, phase})
      :ok
    end

    api =
      Capability.from_functions(
        "api",
        %{"halt" => {[result: "nothing", cost: 1, segment_bound: true], halt}},
        effect: effect
      )

    owner =
      start_supervised!(
        {NorthTalk, [transport: Reactor, drive: :manual, observer: test, reports_to: test] ++ opts},
        id: make_ref()
      )

    NorthTalk.define_capability!(owner, api)
    grant = NorthTalk.grant!(owner, "api")
    group = NorthTalk.new_group!(owner, "g", [])
    NorthTalk.load!(group, "s", @source, grants: %{"api" => grant})
    NorthTalk.load!(group, "log", @log, [])
    {owner, group}
  end

  defp kinds(reports), do: Enum.map(reports, & &1["kind"])
  defp notes(reports), do: Enum.filter(reports, &(&1["kind"] == "run end" and &1["handler"] == "note"))

  test "requests paused-inputs-v1 in hello and admits a callback's Stop before its result" do
    {_owner, group} =
      start(fn call ->
        {NorthTalk.deliver(call.group, "log", "note", [1]), NorthTalk.stop(call.group, "s")}
      end)

    assert_receive {:frame, "hello", _, features} when is_list(features)
    assert "paused-inputs-v1" in features

    {:ok, _} = NorthTalk.deliver(group, "s", "go")
    assert_received {:frame, "deliver", _, _}
    {:ok, pump} = NorthTalk.pump(group)

    # Both were admitted at receipt, inside the Pump's exchange.
    assert_received {:callback, {{:ok, note}, :ok}}
    assert is_binary(note)
    assert_received {:frame, "pump", pump_ref, _}
    assert_received {:frame, "deliver", deliver_ref, _}
    assert_received {:frame, "stop", stop_ref, _}
    assert_received {:frame, "op-result", ^pump_ref, _}
    assert pump_ref < deliver_ref and deliver_ref < stop_ref

    # The Stop landed at the crossing: the Segment rolled back, `send done`
    # never ran, and the delivery waits for the next Pump.
    assert_received {:effect, :begin}
    assert_received {:effect, :rollback}
    refute_received {:effect, :commit}
    assert "stop" in kinds(pump.reports)
    assert notes(pump.reports) == []

    {:ok, next} = NorthTalk.pump(group)
    assert [%{"delivery" => ^note}] = notes(next.reports)
  end

  test "without paused-inputs-v1 a callback's calls are refused, not held" do
    {_owner, group} = start(fn call -> NorthTalk.stop(call.group, "s") end, hide: ["paused-inputs-v1"])

    assert_receive {:frame, "hello", _, nil}
    assert_receive {:frame, "hello", _, features}
    refute "paused-inputs-v1" in features

    {:ok, _} = NorthTalk.deliver(group, "s", "go")
    {:ok, pump} = NorthTalk.pump(group)

    assert_received {:callback, {:error, %HostError{code: "reentrant call", detail: detail}}}
    assert detail =~ "paused-inputs-v1"
    refute_received {:frame, "stop", _, _}
    assert_received {:effect, :commit}
    refute "stop" in kinds(pump.reports)
  end

  test "a callback's worker call on its paused Group is refused as reentrant" do
    {owner, group} =
      start(fn call ->
        {NorthTalk.pump(call.group), NorthTalk.new_group(call.owner, "other")}
      end)

    {:ok, _} = NorthTalk.deliver(group, "s", "go")
    {:ok, pump} = NorthTalk.pump(group)

    assert_received {:callback,
                     {{:error, %HostError{code: "reentrant call"}}, {:error, %HostError{code: "reentrant call"}}}}

    assert_received {:effect, :commit}
    assert Enum.any?(pump.reports, &(&1["kind"] == "run end" and &1["outcome"] == "completed"))

    # The Session carries on, and the refused Group can be made afterwards.
    assert {:ok, _} = NorthTalk.new_group(owner, "other")
  end

  test "a callback that waits on a Run needing its paused Group times out and the Run still runs" do
    {_owner, group} =
      start(fn call ->
        try do
          NorthTalk.request(call.group, "log", "note", [2], 100)
        catch
          :exit, {:timeout, _} -> :timed_out
        end
      end)

    {:ok, _} = NorthTalk.deliver(group, "s", "go")
    {:ok, pump} = NorthTalk.pump(group)

    assert_received {:callback, :timed_out}
    assert_received {:frame, "request", _, _}
    assert_received {:effect, :commit}
    assert notes(pump.reports) == []

    {:ok, next} = NorthTalk.pump(group)
    assert [_] = notes(next.reports)
  end

  test "another process's input for the paused Group is admitted in receipt order; other Groups wait" do
    test = self()

    {owner, group} =
      start(fn _call ->
        send(test, {:paused, self()})

        receive do
          :resume -> :resumed
        end
      end)

    other = NorthTalk.new_group!(owner, "other", [])
    NorthTalk.load!(other, "log", @log, [])

    {:ok, _} = NorthTalk.deliver(group, "s", "go")
    pumping = Task.async(fn -> NorthTalk.pump(group) end)
    assert_receive {:paused, callback}

    stopping = Task.async(fn -> NorthTalk.stop(group, "s") end)
    elsewhere = Task.async(fn -> NorthTalk.deliver(other, "log", "note", [3]) end)
    assert :ok = Task.await(stopping)
    refute Task.yield(elsewhere, 50)

    send(callback, :resume)
    assert {:ok, pump} = Task.await(pumping)
    assert {:ok, _} = Task.await(elsewhere)
    assert_received {:effect, :rollback}
    assert "stop" in kinds(pump.reports)
  end

  test "a lifecycle hook's inputs are admitted while its crossing is open" do
    test = self()

    effect = fn
      :begin, effect ->
        send(test, {:hook, NorthTalk.deliver(effect.group, "log", "note", [4])})
        :ok

      phase, _ ->
        send(test, {:effect, phase})
        :ok
    end

    api =
      Capability.from_functions(
        "api",
        %{"halt" => {[result: "nothing", cost: 1, segment_bound: true], fn [], _ -> {:ok, nil} end}},
        effect: effect
      )

    owner = start_supervised!({NorthTalk, transport: Reactor, drive: :manual, observer: test})
    NorthTalk.define_capability!(owner, api)
    grant = NorthTalk.grant!(owner, "api")
    group = NorthTalk.new_group!(owner, "g", [])
    NorthTalk.load!(group, "s", @source, grants: %{"api" => grant})
    NorthTalk.load!(group, "log", @log, [])

    {:ok, _} = NorthTalk.deliver(group, "s", "go")
    {:ok, _} = NorthTalk.pump(group)
    assert_received {:hook, {:ok, note}}
    assert_received {:effect, :commit}

    {:ok, next} = NorthTalk.pump(group)
    assert Enum.any?(next.reports, &(&1["kind"] == "run end" and &1["delivery"] == note))
  end
end
