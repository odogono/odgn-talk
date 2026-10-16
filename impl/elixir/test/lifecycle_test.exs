defmodule NorthTalk.LifecycleTest do
  use ExUnit.Case, async: true
  alias NorthTalk.{Call, Capability, Effect, HostError, Release, Result, ScriptError}

  # A file-like resource: `open` opens a scope that `close` closes, and every
  # crossing is sent to the binding, a pid, in the order it happens.
  defmodule Resource do
    use NorthTalk.Capability, name: "resource"

    operation("open", result: "nothing", cost: 1, scope: %{opens: "file", abandon: "close"}, segment_bound: true)
    def open([], call), do: log(call, {:op, "open", call.automatic})

    operation("close", result: "nothing", cost: 1, scope: %{closes: "file"}, segment_bound: true)
    def close([], call), do: log(call, {:op, "close", call.automatic})

    operation("write", result: "nothing", cost: 1, segment_bound: true)
    def write([], call), do: log(call, {:op, "write", call.automatic})

    def effect(phase, %Effect{binding: pid} = effect) do
      send(pid, {:effect, phase, effect})
      receive_status(pid, phase)
    end

    def release(%Release{binding: pid} = release), do: send(pid, {:release, release})

    # The binding answers each phase's status, `:ok` unless the test set
    # another.
    defp receive_status(pid, phase) do
      send(pid, {:status?, phase, self()})

      receive do
        {:status, status} -> status
      after
        1_000 -> :ok
      end
    end

    defp log(%Call{binding: pid}, event) do
      send(pid, event)
      {:ok, nil}
    end
  end

  setup do
    test = self()
    # Answers the hooks' status questions, so a test can script failures.
    responder =
      spawn_link(fn ->
        responder = fn responder, statuses ->
          receive do
            {:set, phase, status} ->
              responder.(responder, Map.put(statuses, phase, status))

            {:status?, phase, pid} ->
              send(pid, {:status, Map.get(statuses, phase, :ok)})
              send(test, {:asked, phase})
              responder.(responder, statuses)

            other ->
              send(test, other)
              responder.(responder, statuses)
          end
        end

        responder.(responder, %{})
      end)

    %{responder: responder}
  end

  defp start(drive, responder) do
    owner = start_supervised!({NorthTalk, drive: drive})
    :ok = NorthTalk.define_capability!(owner, Resource)
    group = NorthTalk.new_group!(owner, "g", [])
    grant = NorthTalk.grant!(owner, Resource, binding: responder)
    {owner, group, grant}
  end

  defp events(n), do: for(_ <- 1..n, do: next_event())

  defp next_event do
    receive do
      {:asked, _} -> next_event()
      {:effect, phase, _} -> {:effect, phase}
      {:release, %Release{reason: reason, grant: grant}} -> {:release, grant, reason}
      {:op, _, _} = op -> op
    after
      1_000 -> flunk("no event")
    end
  end

  test "a Segment begins, abandons a scope left open, then commits", %{responder: r} do
    {_owner, group, grant} = start(:auto, r)

    source = """
    script variable count = 0
    on go
      ask r to open
      ask r to write
      put 2 into count
      return count
    end go
    """

    NorthTalk.load!(group, "s", source, grants: %{"r" => grant})
    assert {:ok, %Result{value: 2}} = NorthTalk.request(group, "s", "go")

    assert events(5) == [
             {:effect, :begin},
             {:op, "open", false},
             {:op, "write", false},
             {:op, "close", true},
             {:effect, :commit}
           ]
  end

  test "an effect hook sees the Segment and every enrolled Grant", %{responder: r} do
    {_owner, group, grant} = start(:auto, r)
    NorthTalk.load!(group, "s", "on go\n  ask r to write\nend go\n", grants: %{"r" => grant})
    {:ok, _} = NorthTalk.request(group, "s", "go")

    assert_receive {:effect, :begin,
                    %Effect{script: "s", grant: "r", binding: ^r, grants: [{"r", ^r}], segment: segment, now: now}}

    assert is_binary(segment) and is_binary(now)
  end

  test "a failed commit ends the Run effect failed", %{responder: r} do
    {_owner, group, grant} = start(:auto, r)
    send(r, {:set, :commit, :failed})
    NorthTalk.load!(group, "s", "on go\n  ask r to write\n  return 1\nend go\n", grants: %{"r" => grant})
    assert {:error, %ScriptError{outcome: "effect failed"}} = NorthTalk.request(group, "s", "go")
    assert events(3) == [{:effect, :begin}, {:op, "write", false}, {:effect, :commit}]
    assert_receive {:effect, :rollback, _}
  end

  test "a hook that raises is unknown, which stops the Group", %{responder: r} do
    owner = start_supervised!({NorthTalk, []})

    cap =
      Capability.from_functions(
        "bad",
        %{"write" => {[result: "nothing", segment_bound: true], fn [], _ -> {:ok, nil} end}},
        effect: fn
          :commit, _ -> raise "boom"
          _, _ -> :ok
        end
      )

    :ok = NorthTalk.define_capability!(owner, cap)
    group = NorthTalk.new_group!(owner, "g", [])
    NorthTalk.load!(group, "s", "on go\n  ask b to write\nend go\n", grants: %{"b" => NorthTalk.grant!(owner, "bad")})
    assert {:error, %ScriptError{}} = NorthTalk.request(group, "s", "go")
    assert {:error, %HostError{code: "effect state unknown"}} = NorthTalk.load(group, "t", "on go\nend go\n")
  end

  test "a Reload rolls back a preempted Segment and releases before its reply", %{responder: r} do
    {_owner, group, grant} = start(:manual, r)
    source = "on go\n  ask r to write\n  repeat forever\n  end repeat\nend go\n"
    NorthTalk.load!(group, "s", source, grants: %{"r" => grant})
    {:ok, _} = NorthTalk.deliver(group, "s", "go")
    assert {:ok, %{state: "sliced"}} = NorthTalk.pump(group, fuel_slice: 40)
    assert events(2) == [{:effect, :begin}, {:op, "write", false}]

    assert {:ok, reports} = NorthTalk.reload(group, "s", "on go\n  return 2\nend go\n")
    assert events(2) == [{:effect, :rollback}, {:release, "r", :reload}]
    assert Enum.any?(reports, &(&1["kind"] == "stop"))

    {:ok, _} = NorthTalk.deliver(group, "s", "go")
    assert {:ok, %{reports: reports}} = NorthTalk.pump(group)
    assert %{"result" => 2} = Enum.find(reports, &(&1["kind"] == "run end"))
  end

  test "a Library replacement whose rollback is unknown keeps the old code", %{responder: r} do
    {owner, group, grant} = start(:manual, r)
    old = NorthTalk.compile_library!(owner, "user", "1", "function one\n  return 1\nend one\n", [])
    new = NorthTalk.compile_library!(owner, "user", "2", "function one\n  return 2\nend one\n", [])
    :ok = NorthTalk.add_library!(group, old)
    source = "use one from user\non go\n  ask r to write\n  repeat forever\n  end repeat\nend go\n"
    NorthTalk.load!(group, "s", source, grants: %{"r" => grant})
    {:ok, _} = NorthTalk.deliver(group, "s", "go")
    {:ok, %{state: "sliced"}} = NorthTalk.pump(group, fuel_slice: 40)
    events(2)

    send(r, {:set, :rollback, :unknown})
    assert {:error, %HostError{code: "effect state unknown"}} = NorthTalk.replace_library(group, new)
    assert events(2) == [{:effect, :rollback}, {:release, "r", :reload}]
  end

  test "a stop releases each Grant before the stop report", %{responder: r} do
    {_owner, group, grant} = start(:manual, r)
    NorthTalk.load!(group, "s", "on go\nend go\n", grants: %{"r" => grant})
    :ok = NorthTalk.stop!(group, "s", "done")
    assert {:ok, %{reports: reports}} = NorthTalk.pump(group)
    assert [{:release, "r", :stop}] = events(1)
    assert Enum.any?(reports, &(&1["kind"] == "stop"))
  end

  test "a Reload settles a waiting request and runs the new code", %{responder: r} do
    owner = start_supervised!({NorthTalk, []})
    cap = Capability.from_functions("hold", %{"hold" => {[mode: :suspending], fn [], call -> {:defer, call.id} end}})
    :ok = NorthTalk.define_capability!(owner, cap)
    group = NorthTalk.new_group!(owner, "g", [])
    _ = r

    NorthTalk.load!(group, "s", "script variable n = 7\non go\n  ask h to hold and wait\nend go\n",
      grants: %{"h" => NorthTalk.grant!(owner, "hold")}
    )

    task = Task.async(fn -> NorthTalk.request(group, "s", "go") end)
    Process.sleep(50)
    assert {:ok, _} = NorthTalk.reload(group, "s", "script variable n = 0\non go\n  return n\nend go\n")
    assert {:error, %ScriptError{}} = Task.await(task)
    assert {:ok, %Result{value: 7}} = NorthTalk.request(group, "s", "go")
    assert %{calls: calls} = :sys.get_state(owner)
    assert calls == %{}

    assert {:ok, _} =
             NorthTalk.reload(group, "s", "script variable n = 0\non go\n  return n\nend go\n", variables: :reset)

    assert {:ok, %Result{value: 0}} = NorthTalk.request(group, "s", "go")
    assert :ok = NorthTalk.extend(group, "s", "on more\n  return 1\nend more\n")
    assert {:ok, %Result{value: 1}} = NorthTalk.request(group, "s", "more")
  end
end
