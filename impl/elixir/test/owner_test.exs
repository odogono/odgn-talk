defmodule NorthTalk.OwnerTest do
  use ExUnit.Case, async: true
  alias NorthTalk.{HostError, LoadError, Result, ScriptError}

  @source """
  on plus a, b
    return a + b
  end plus

  on boom
    return 1 / 0
  end boom

  on spin n
    put 0 into total
    repeat for each i in 1..n
      put total + i into total
    end repeat
    return total
  end spin
  """

  setup do
    owner = start_supervised!({NorthTalk, []})
    group = NorthTalk.new_group!(owner, "g", [])
    "s" = NorthTalk.load!(group, "s", @source, [])
    %{owner: owner, group: group}
  end

  test "hello reports the Zig Core", %{owner: owner} do
    assert %{"core" => "zig/" <> _, "saveFormat" => "zig/" <> _} = NorthTalk.versions(owner)
  end

  test "a request returns the Handler's result and its report", %{group: group} do
    assert {:ok, %Result{value: value, delivery: "d" <> _, report: report}} =
             NorthTalk.request(group, "s", "plus", [1, Decimal.new("2.50")])

    assert Decimal.equal?(value, Decimal.new("3.50"))
    assert Decimal.to_string(value) == "3.50"
    assert %{"kind" => "run end", "outcome" => "completed", "fuel" => fuel} = report
    assert fuel > 0
  end

  test "random draws from the Group's seed", %{owner: owner} do
    source = "on roll\n  return [random(6), random(6), random(6)]\nend roll\n"

    roll = fn seed ->
      group = NorthTalk.new_group!(owner, "dice-#{System.unique_integer([:positive])}", seed: seed)
      "dice" = NorthTalk.load!(group, "dice", source, [])
      {:ok, %Result{value: value}} = NorthTalk.request(group, "dice", "roll")
      value
    end

    assert roll.(42) == [3, 6, 4]
    assert roll.(0) == [1, 6, 1]
    assert roll.(18_446_744_073_709_551_615) == roll.(18_446_744_073_709_551_615)
    assert {:error, %HostError{code: "invalid value"}} = NorthTalk.new_group(owner, "bad", seed: -1)
  end

  test "a Run that errors is a ScriptError", %{group: group} do
    assert {:error, %ScriptError{outcome: "errored", error: %{"code" => "division by zero"}}} =
             NorthTalk.request(group, "s", "boom")
  end

  test "an unhandled message is a ScriptError", %{group: group} do
    assert {:error, %ScriptError{outcome: "unhandled"}} = NorthTalk.request(group, "s", "nope")
  end

  test "a load error carries the diagnostics", %{group: group} do
    assert {:error, %LoadError{diagnostics: [%{"code" => "unexpected token", "line" => 3}]}} =
             NorthTalk.load(group, "bad", "on x\n  return (\nend x\n")
  end

  test "Host misuse is a HostError and the owner carries on", %{group: group} do
    assert {:error, %HostError{code: "invalid value"}} = NorthTalk.deliver(group, "missing", "plus", [1, 2])
    assert {:error, %HostError{code: "invalid value"}} = NorthTalk.request(group, "s", "plus", [1.5, 2])
    assert {:ok, %Result{value: 3}} = NorthTalk.request(group, "s", "plus", [1, 2])
  end

  test "a long Run is driven across many Fuel Slices", %{owner: owner} do
    group = NorthTalk.new_group!(owner, "long", [])
    NorthTalk.load!(group, "s", @source, [])
    me = self()
    spawn(fn -> send(me, {:long, NorthTalk.request(group, "s", "spin", [20_000], 30_000)}) end)
    # Another Group of the same owner progresses while the long one is sliced.
    {:ok, %Result{value: 3}} =
      NorthTalk.request(NorthTalk.Group.__struct__(owner: owner, name: "g"), "s", "plus", [1, 2])

    assert_receive {:long, {:ok, %Result{value: 200_010_000}}}, 30_000
  end

  test "deliver returns on acceptance, and the report follows", %{group: _} do
    owner = start_supervised!({NorthTalk, reports_to: self(), name: :reporting}, id: :reporting)
    group = NorthTalk.new_group!(owner, "g", [])
    NorthTalk.load!(group, "s", @source, [])
    assert {:ok, delivery} = NorthTalk.deliver(group, "s", "plus", [2, 3])
    assert_receive {:north_talk, ^group, %{"kind" => "run end", "delivery" => ^delivery, "result" => 5}}
  end

  test "Libraries compile once and are added to Groups", %{owner: owner} do
    lib = NorthTalk.compile_library!(owner, "util", "1", "function twice x\n  return x * 2\nend twice\n", [])

    for name <- ["a", "b"] do
      group = NorthTalk.new_group!(owner, name, [])
      :ok = NorthTalk.add_library!(group, lib)
      NorthTalk.load!(group, "s", "use twice from util\non go x\n  return twice(x)\nend go\n", [])
      assert {:ok, %Result{value: 42}} = NorthTalk.request(group, "s", "go", [21])
    end
  end

  test "manual driving runs nothing until the caller Pumps" do
    owner = start_supervised!({NorthTalk, drive: :manual}, id: :manual)
    group = NorthTalk.new_group!(owner, "g", [])
    NorthTalk.load!(group, "s", @source, [])
    task = Task.async(fn -> NorthTalk.request(group, "s", "plus", [1, 2]) end)
    refute Task.yield(task, 100)
    now = ~U[2026-10-10 12:00:00.250Z]
    assert {:ok, %{state: "idle", reports: reports}} = NorthTalk.pump(group, now: now)
    assert Enum.any?(reports, &(&1["kind"] == "run end"))
    assert {:ok, %Result{value: 3}} = Task.await(task)

    assert {:error, %HostError{code: "clock backwards"}} =
             NorthTalk.pump(group, now: ~U[2026-10-10 11:00:00Z])
  end

  test "independent owners run concurrently" do
    results =
      1..4
      |> Task.async_stream(fn i ->
        {:ok, owner} = NorthTalk.start_link()
        group = NorthTalk.new_group!(owner, "g", [])
        NorthTalk.load!(group, "s", @source, [])
        {:ok, %Result{value: v}} = NorthTalk.request(group, "s", "plus", [i, i])
        NorthTalk.close(owner)
        v
      end)
      |> Enum.map(fn {:ok, v} -> v end)

    assert results == [2, 4, 6, 8]
  end

  test "a lost instance fails waiting requests and stops the owner" do
    Process.flag(:trap_exit, true)
    {:ok, owner} = NorthTalk.start_link(drive: :manual)
    group = NorthTalk.new_group!(owner, "g", [])
    NorthTalk.load!(group, "s", @source, [])
    task = Task.async(fn -> NorthTalk.request(group, "s", "plus", [1, 2]) end)
    Process.sleep(50)
    %{transport: %{pid: wasm}} = :sys.get_state(owner)
    GenServer.stop(wasm)
    catch_exit(NorthTalk.pump(group))
    assert {:error, %HostError{code: "instance lost"}} = Task.await(task)
    assert_receive {:EXIT, ^owner, {:shutdown, {:instance_lost, _}}}
  end
end
