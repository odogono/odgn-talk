defmodule NorthTalk.GroupsTest do
  use ExUnit.Case, async: true
  alias NorthTalk.{Groups, HostError, Result, Transport}

  # The real reactor, with a short export timeout once it has started.
  defmodule Short do
    def start(opts) do
      with {:ok, t} <- Transport.Wasi.start(opts), do: {:ok, %{t | timeout: opts[:call_timeout]}}
    end
  end

  @source """
  script variable n = 0

  on count
    put n + 1 into n
    return n
  end count

  on forever
    repeat while true
    end repeat
  end forever

  on spin k
    put 0 into i
    repeat while i < k
      put i + 1 into i
    end repeat
    return i
  end spin
  """

  setup context do
    groups = Module.concat(__MODULE__, "G#{context.line}")
    start_supervised!({Groups, name: groups, notify: self()})
    %{groups: groups}
  end

  defp init(owner, key) do
    with {:ok, group} <- NorthTalk.new_group(owner, key),
         {:ok, "s"} <- NorthTalk.load(group, "s", @source),
         do: {:ok, group}
  end

  defp count(group), do: NorthTalk.request!(group, "s", "count", [], 5_000).value

  defp owners(groups) do
    Groups.members(groups)
    |> DynamicSupervisor.which_children()
    |> Enum.flat_map(fn {_, member, _, _} -> Supervisor.which_children(member) end)
    |> Enum.filter(&match?({:owner, _, _, _}, &1))
  end

  test "each key gets its own owner and instance, ready once initialized", %{groups: groups} do
    assert :error = Groups.lookup(groups, "a")
    assert {:ok, a} = Groups.start_group(groups, "a", &init/2)
    assert {:ok, b} = Groups.start_group(groups, "b", &init/2)
    assert_receive {:north_talk_group, "a", {:ready, ^a}}, 5_000

    assert {:ok, ^a} = Groups.lookup(groups, "a")
    assert a.owner != b.owner
    assert [1, 2, 1] == [count(a), count(a), count(b)]
    assert Enum.sort(Groups.keys(groups)) == ["a", "b"]
  end

  test "concurrent starts for one key make one group and no extra instance", %{groups: groups} do
    results =
      1..8
      |> Enum.map(fn _ -> Task.async(fn -> Groups.start_group(groups, "k", &init/2) end) end)
      |> Enum.map(&Task.await/1)

    assert [{:ok, group}] = Enum.filter(results, &match?({:ok, _}, &1))
    assert Enum.all?(results -- [{:ok, group}], &(&1 == {:error, :already_started}))
    assert length(owners(groups)) == 1
  end

  test "lookup fails until a slow initialization succeeds", %{groups: groups} do
    test = self()

    slow = fn owner, key ->
      send(test, {:initializing, self()})
      receive do: (:go -> init(owner, key))
    end

    starting = Task.async(fn -> Groups.start_group(groups, "slow", slow) end)
    assert_receive {:initializing, initializing}, 5_000
    assert :error = Groups.lookup(groups, "slow")
    assert {:error, :already_started} = Groups.start_group(groups, "slow", &init/2)

    send(initializing, :go)
    assert {:ok, group} = Task.await(starting)
    assert {:ok, ^group} = Groups.lookup(groups, "slow")
  end

  test "a failed initialization leaves nothing behind", %{groups: groups} do
    test = self()

    failing = fn owner, key ->
      send(test, {:owner, owner})
      {:ok, _} = NorthTalk.new_group(owner, key)
      {:error, :no_save}
    end

    assert {:error, :no_save} = Groups.start_group(groups, "f", failing)
    assert_receive {:owner, owner}
    refute Process.alive?(owner)
    assert :error = Groups.lookup(groups, "f")
    assert [] = Groups.keys(groups)
    assert [] = DynamicSupervisor.which_children(Groups.members(groups))

    assert {:error, %RuntimeError{}} = Groups.start_group(groups, "r", fn _, _ -> raise "boom" end)

    assert {:error, :init_timeout} =
             Groups.start_group(groups, "t", fn _, _ -> Process.sleep(:infinity) end, init_timeout: 50)

    assert {:error, {:not_this_owners_group, _}} = Groups.start_group(groups, "w", fn _, _ -> {:ok, :nope} end)
    assert [] = DynamicSupervisor.which_children(Groups.members(groups))

    # The key is free again.
    assert {:ok, _} = Groups.start_group(groups, "f", &init/2)
  end

  test "a busy group does not hold up another", %{groups: groups} do
    owner = [fuel_slice: 500_000_000, limits: [fuel_per_run: 500_000_000, alloc_per_run: 268_435_456]]
    {:ok, busy} = Groups.start_group(groups, "busy", &init/2, owner: owner)
    {:ok, other} = Groups.start_group(groups, "other", &init/2)

    spinning = Task.async(fn -> NorthTalk.request(busy, "s", "spin", [3_000_000], 60_000) end)
    Process.sleep(50)
    assert Task.yield(spinning, 0) == nil
    assert count(other) == 1
    assert Task.yield(spinning, 0) == nil
    assert {:ok, %Result{}} = Task.await(spinning, 60_000)
  end

  test "a trapped group restarts alone, and old handles are not redirected", %{groups: groups} do
    owner = [transport: Short, call_timeout: 200, fuel_slice: 100_000_000, limits: [fuel_per_run: 100_000_000]]
    {:ok, trapped} = Groups.start_group(groups, "trapped", &init/2, owner: owner)
    assert_receive {:north_talk_group, "trapped", {:ready, ^trapped}}, 5_000
    {:ok, other} = Groups.start_group(groups, "other", &init/2)
    assert count(other) == 1

    assert {:error, %HostError{code: "instance trapped"}} = NorthTalk.request(trapped, "s", "forever")
    assert_receive {:north_talk_group, "trapped", {:ready, restarted}}, 5_000
    assert restarted.owner != trapped.owner
    assert {:ok, ^restarted} = Groups.lookup(groups, "trapped")

    # Fresh state from the init function, and the old handle exits.
    assert count(restarted) == 1
    assert {:noproc, _} = catch_exit(NorthTalk.request(trapped, "s", "count"))
    assert count(other) == 2
  end

  test "a group that exhausts its budget stops alone", %{groups: groups} do
    {:ok, other} = Groups.start_group(groups, "other", &init/2)
    {:ok, group} = Groups.start_group(groups, "x", &init/2, max_restarts: 2, max_seconds: 60)
    assert_receive {:north_talk_group, "x", {:ready, ^group}}, 5_000

    kill = fn g -> Process.exit(g.owner, :kill) end
    kill.(group)
    assert_receive {:north_talk_group, "x", {:ready, g2}}, 5_000
    kill.(g2)
    assert_receive {:north_talk_group, "x", {:ready, g3}}, 5_000
    kill.(g3)

    assert_receive {:north_talk_group, "x", {:stopped, :restarts_exhausted}}, 5_000
    assert :error = Groups.lookup(groups, "x")
    assert ["other"] = Groups.keys(groups)
    assert count(other) == 1
  end

  test "restart: :never stops the group on its first exit", %{groups: groups} do
    {:ok, group} = Groups.start_group(groups, "n", &init/2, restart: :never)
    Process.exit(group.owner, :kill)
    assert_receive {:north_talk_group, "n", {:stopped, :restarts_exhausted}}, 5_000
    assert :error = Groups.lookup(groups, "n")
  end

  test "stop_group releases the instance without a restart", %{groups: groups} do
    {:ok, group} = Groups.start_group(groups, "s", &init/2)
    assert_receive {:north_talk_group, "s", {:ready, ^group}}, 5_000
    ref = Process.monitor(group.owner)

    assert :ok = Groups.stop_group(groups, "s")
    assert_receive {:DOWN, ^ref, :process, _, :shutdown}
    assert :error = Groups.lookup(groups, "s")
    assert {:error, :not_found} = Groups.stop_group(groups, "s")
    refute_receive {:north_talk_group, "s", {:stopped, _}}
    refute_receive {:north_talk_group, "s", {:ready, _}}

    # The key can be started again straight away.
    assert {:ok, _} = Groups.start_group(groups, "s", &init/2)
  end
end
