defmodule NorthTalk.CapabilityTest do
  use ExUnit.Case, async: true
  alias NorthTalk.{Call, Capability, Result, ScriptError}

  defmodule Inventory do
    use NorthTalk.Capability, name: "inventory", timeout: 200

    operation("count", args: ["text"], result: "number", cost: 1, errors: [%{code: "unknown sku"}])
    def count(["missing"], _call), do: {:error, %{code: "unknown sku", message: "no such sku"}}
    def count([sku], call), do: {:ok, byte_size(sku) * call.binding}

    operation("note", mode: :fire_and_forget, args: ["text"], cost: 1)

    def note([text], call) do
      send(call.binding, {:note, text})
      :noreply
    end

    operation("reserve", mode: :suspending, args: ["text"], result: "text", cost: 1, function: :reserve_later)

    def reserve_later([sku], call) do
      send(call.binding, {:reserve, call.id, self()})
      {:defer, {:reserve, sku}}
    end

    operation("slow", cost: 1)
    def slow([], _call), do: Process.sleep(:infinity)

    operation("crash", cost: 1)
    def crash([], _call), do: raise("boom")
  end

  @source """
  on count sku
    ask stock to count sku
    return it
  end count

  on note text
    tell stock to note text
    return "noted"
  end note

  on reserve sku
    ask stock to reserve sku and wait
    return it
  end reserve

  on slow
    ask stock to slow
    return it
  end slow

  on crash
    ask stock to crash
    return it
  end crash
  """

  setup do
    owner = start_supervised!({NorthTalk, []})
    :ok = NorthTalk.define_capability!(owner, Inventory)
    group = NorthTalk.new_group!(owner, "g", [])
    %{owner: owner, group: group}
  end

  defp load(group, binding, source \\ @source) do
    grant = NorthTalk.grant!(group.owner, Inventory, binding: binding)
    NorthTalk.load!(group, "s", source, grants: %{"stock" => grant})
  end

  test "an immediate Operation answers inside the Run, with its Grant's binding", %{group: group} do
    load(group, 10)
    assert {:ok, %Result{value: 30}} = NorthTalk.request(group, "s", "count", ["abc"])
  end

  test "a declared failure is raised in the Script", %{group: group} do
    load(group, 1)

    assert {:error, %ScriptError{outcome: "errored", error: %{"code" => "unknown sku", "message" => "no such sku"}}} =
             NorthTalk.request(group, "s", "count", ["missing"])
  end

  test "a fire-and-forget Operation runs in order and returns nothing", %{group: group} do
    load(group, self())
    assert {:ok, %Result{value: "noted"}} = NorthTalk.request(group, "s", "note", ["hi"])
    assert_received {:note, "hi"}
  end

  test "a deferred Operation suspends the Run until answer/3", %{owner: owner, group: group} do
    load(group, self())
    task = Task.async(fn -> NorthTalk.request(group, "s", "reserve", ["a1"]) end)
    assert_receive {:reserve, _call, _pid}
    refute Task.yield(task, 100)
    assert :ok = NorthTalk.answer(owner, {:reserve, "a1"}, "held")
    assert {:ok, %Result{value: "held"}} = Task.await(task)
    assert {:error, :unknown_ref} = NorthTalk.answer(owner, {:reserve, "a1"}, "again")
  end

  test "fail/3 settles a deferred call with a failure", %{owner: owner, group: group} do
    load(group, self())
    task = Task.async(fn -> NorthTalk.request(group, "s", "reserve", ["a1"]) end)
    assert_receive {:reserve, _, _}
    assert :ok = NorthTalk.fail(owner, {:reserve, "a1"}, "sold out")
    assert {:error, %ScriptError{error: %{"code" => "sold out"}}} = Task.await(task)
  end

  test "a crash or a timeout is a Host failure, and the owner carries on", %{group: group} do
    load(group, 1)
    assert {:error, %ScriptError{error: %{"code" => "host error"}}} = NorthTalk.request(group, "s", "crash")
    assert {:error, %ScriptError{error: %{"code" => "host error"}}} = NorthTalk.request(group, "s", "slow")
    assert {:ok, %Result{value: 2}} = NorthTalk.request(group, "s", "count", ["ab"])
  end

  test "Operations of the same name in different Capabilities don't collide", %{owner: owner, group: group} do
    for name <- ["left", "right"] do
      cap =
        Capability.from_functions(name, %{
          "get" => {[result: "text"], fn [], call -> {:ok, "#{call.capability}:#{call.binding}"} end}
        })

      :ok = NorthTalk.define_capability!(owner, cap)
    end

    grants = %{
      "a" => NorthTalk.grant!(owner, "left", binding: 1),
      "b" => NorthTalk.grant!(owner, "right", binding: 2),
      "c" => NorthTalk.grant!(owner, "right", binding: 3)
    }

    source = """
    on go
      ask a to get
      put it into x
      ask b to get
      put x & " " & it into x
      ask c to get
      return x & " " & it
    end go
    """

    NorthTalk.load!(group, "s", source, grants: grants)
    assert {:ok, %Result{value: "left:1 right:2 right:3"}} = NorthTalk.request(group, "s", "go")
  end

  test "Argument Labels are declared, sent, checked at load and leave the call positional", %{
    owner: owner,
    group: group
  } do
    move = {[args: ["text", "text"], labels: ["to"], result: "text"], fn [from, to], _ -> {:ok, from <> ">" <> to} end}
    cap = Capability.from_functions("world", %{"move" => move})
    assert [%{"labels" => ["to"]}] = Capability.declarations(cap)

    unlabelled =
      Capability.from_functions("plain", %{"move" => {[args: ["text", "text"], labels: []], fn _, _ -> {:ok, nil} end}})

    refute Map.has_key?(hd(Capability.declarations(unlabelled)), "labels")

    for labels <- [["to", "by"], ["from"], ["with"]] do
      bad =
        Capability.from_functions("bad", %{
          "move" => {[args: ["text", "text"], labels: labels], fn _, _ -> {:ok, nil} end}
        })

      assert {:error, %NorthTalk.HostError{code: "invalid value"}} = NorthTalk.define_capability(owner, bad)
    end

    :ok = NorthTalk.define_capability!(owner, cap)
    grant = NorthTalk.grant!(owner, "world")

    source =
      "on go a, b\n  ask world to move a to b\n  put it into x\n  ask world to move a, b\n  return x & \" \" & it\nend go\n"

    NorthTalk.load!(group, "s", source, grants: %{"world" => grant})
    assert {:ok, %Result{value: "pass>hangar pass>hangar"}} = NorthTalk.request(group, "s", "go", ["pass", "hangar"])

    assert {:error, %NorthTalk.LoadError{diagnostics: [%{"code" => "wrong labels", "line" => 2}]}} =
             NorthTalk.load(group, "t", "on go\n  ask world to move \"a\" at \"b\"\nend go\n",
               grants: %{"world" => grant}
             )
  end

  test "a Script can call only the Operations it was granted", %{owner: owner, group: group} do
    grant = NorthTalk.grant!(owner, Inventory, ops: ["count"], binding: 1)
    assert {:error, %NorthTalk.LoadError{}} = NorthTalk.load(group, "s", @source, grants: %{"stock" => grant})
    assert {:error, %NorthTalk.LoadError{}} = NorthTalk.load(group, "t", "on go\n  ask stock to count \"x\"\nend go\n")
  end

  test "an abandoned call kills its Task and forgets its ref", %{owner: owner, group: group} do
    me = self()

    cap =
      Capability.from_functions("timed", %{
        "pause" =>
          {[mode: :suspending, max_pending: 50, result: "text"],
           fn [], _ ->
             send(me, {:task, self()})
             Process.sleep(:infinity)
           end},
        "hold" => {[mode: :suspending, max_pending: 50, result: "text"], fn [], call -> {:defer, call.id} end}
      })

    :ok = NorthTalk.define_capability!(owner, cap)
    grant = NorthTalk.grant!(owner, "timed")
    source = "on pause\n  ask t to pause and wait\nend pause\non hold\n  ask t to hold and wait\nend hold\n"
    NorthTalk.load!(group, "s", source, grants: %{"t" => grant})

    assert {:error, %ScriptError{error: %{"code" => "timeout"}}} = NorthTalk.request(group, "s", "pause")
    assert_received {:task, pid}
    refute Process.alive?(pid)

    assert {:error, %ScriptError{error: %{"code" => "timeout"}}} = NorthTalk.request(group, "s", "hold")
    assert %{calls: calls, deferred: deferred} = :sys.get_state(owner)
    assert calls == %{} and deferred == %{}
  end

  test "the owner's shutdown stops suspended work", %{group: group} do
    me = self()
    {:ok, owner} = NorthTalk.start_link()

    cap =
      Capability.from_functions("work", %{
        "run" =>
          {[mode: :suspending],
           fn [], _ ->
             send(me, {:task, self()})
             Process.sleep(:infinity)
           end}
      })

    :ok = NorthTalk.define_capability!(owner, cap)
    g = NorthTalk.new_group!(owner, group.name, [])

    NorthTalk.load!(g, "s", "on go\n  ask w to run and wait\nend go\n",
      grants: %{"w" => NorthTalk.grant!(owner, "work")}
    )

    {:ok, _} = NorthTalk.deliver(g, "s", "go", [])
    assert_receive {:task, pid}
    ref = Process.monitor(pid)
    NorthTalk.close(owner)
    assert_receive {:DOWN, ^ref, :process, ^pid, _}
  end

  test "a callback gets the call's identity", %{owner: owner, group: group} do
    me = self()
    cap = Capability.from_functions("probe", %{"look" => {[], fn [], call -> send(me, call) && {:ok, nil} end}})
    :ok = NorthTalk.define_capability!(owner, cap)

    NorthTalk.load!(group, "s", "on go\n  ask p to look\nend go\n",
      grants: %{"p" => NorthTalk.grant!(owner, "probe", binding: :b)}
    )

    {:ok, _} = NorthTalk.request(group, "s", "go")

    assert_received %Call{
      script: "s",
      grant: "p",
      capability: "probe",
      operation: "look",
      mode: :immediate,
      binding: :b,
      id: id,
      now: now
    }

    assert is_binary(id) and is_binary(now)
  end
end
