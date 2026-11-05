defmodule NorthTalk.MusicalClockTest do
  use ExUnit.Case, async: true
  alias NorthTalk.{Call, Capability, Group, HostError, PendingCall, Quantity, Restored}

  # A musical clock that tells the test of each wait and defers it, as a
  # Transport would until the line it waits for.
  defp clock(test) do
    Capability.musical_clock(
      fn count, call ->
        send(test, {:wait, count, call})
        {:defer, {:wait, call.group.name, call.id}}
      end,
      cost: 3
    )
  end

  defp owner do
    owner = start_supervised!({NorthTalk, reports_to: self()}, id: make_ref())
    :ok = NorthTalk.define_capability!(owner, clock(self()))
    {owner, NorthTalk.grant!(owner, "musical-clock")}
  end

  defp run_end(name) do
    receive do
      {:north_talk, %Group{name: ^name}, %{"kind" => "run end"} = report} -> report
    after
      2_000 -> flunk("no run end in #{name}")
    end
  end

  @song """
  on go
    wait 0 beats
    wait 8 bars
    return 1
  end go
  """

  test "without a musical clock, a wait in bars raises no musical time" do
    owner = start_supervised!({NorthTalk, reports_to: self()}, id: make_ref())
    group = NorthTalk.new_group!(owner, "g", [])
    NorthTalk.load!(group, "s", "on go\n  wait 2 bars\nend go\n", [])
    {:ok, _} = NorthTalk.deliver(group, "s", "go")
    assert %{"outcome" => "errored", "error" => %{"code" => "no musical time"}} = run_end("g")
  end

  test "a wait in bars calls the Group's musical clock, and its answer ends the wait" do
    {owner, clock} = owner()
    group = NorthTalk.new_group!(owner, "g", musical_clock: clock)
    NorthTalk.load!(group, "s", @song, [])
    {:ok, _} = NorthTalk.deliver(group, "s", "go")

    # `wait 0 beats` goes straight on and calls nothing.
    assert_receive {:wait, %Quantity{} = count, %Call{} = call}
    assert NorthTalk.Value.encode(count) == %{"$quantity" => ["8", "bar"]}

    assert %Call{grant: "musical-clock", capability: "musical-clock", operation: "wait", mode: :suspending} = call
    refute_receive {:wait, _, _}, 50
    refute_receive {:north_talk, %Group{name: "g"}, %{"kind" => "run end"}}, 50

    :ok = NorthTalk.answer(owner, {:wait, "g", call.id}, nil)
    assert %{"outcome" => "completed", "result" => 1} = run_end("g")
  end

  test "a failed musical wait raises the Host's code in the Run" do
    {owner, clock} = owner()
    group = NorthTalk.new_group!(owner, "g", musical_clock: clock)

    NorthTalk.load!(
      group,
      "s",
      "on go\n  try\n    wait 1 bar\n  catch e\n    return the code of e\n  end try\nend go\n",
      []
    )

    {:ok, _} = NorthTalk.deliver(group, "s", "go")
    assert_receive {:wait, _, call}
    :ok = NorthTalk.fail(owner, {:wait, "g", call.id}, "transport stopped")
    assert %{"outcome" => "completed", "result" => "transport stopped"} = run_end("g")
  end

  test "a fractional count raises before the clock is called" do
    {owner, clock} = owner()
    group = NorthTalk.new_group!(owner, "g", musical_clock: clock)
    NorthTalk.load!(group, "s", "on go\n  wait 1.5 bars\nend go\n", [])
    {:ok, _} = NorthTalk.deliver(group, "s", "go")
    assert %{"error" => %{"code" => "out of domain"}} = run_end("g")
    refute_received {:wait, _, _}
  end

  test "a Script can't be given a Grant under the reserved name" do
    {owner, clock} = owner()
    group = NorthTalk.new_group!(owner, "g", musical_clock: clock)

    assert {:error, %HostError{code: "invalid value"}} =
             NorthTalk.load(group, "s", "on go\nend go\n", grants: %{"musical-clock" => clock})

    plain = NorthTalk.new_group!(owner, "plain", [])

    assert {:error, %HostError{code: "invalid value"}} =
             NorthTalk.load(plain, "s", "on go\nend go\n", grants: %{"musical-clock" => clock})
  end

  test "a musical clock must be a Grant of one musical_clock/2 made" do
    {owner, clock} = owner()

    pause =
      Capability.from_functions("pause", %{
        "pause" => {[mode: :suspending, args: ["any"]], fn _, _ -> {:ok, nil} end}
      })

    :ok = NorthTalk.define_capability!(owner, pause)
    plain = NorthTalk.grant!(owner, "pause")
    assert {:error, %HostError{code: "invalid value"}} = NorthTalk.new_group(owner, "g", musical_clock: plain)
    assert {:error, %HostError{code: "invalid value"}} = NorthTalk.new_group(owner, "g", musical_clock: :tick)

    other = start_supervised!({NorthTalk, []}, id: make_ref())
    assert {:error, %HostError{code: "invalid value"}} = NorthTalk.new_group(other, "g", musical_clock: clock)

    assert_raise ArgumentError, fn -> Capability.musical_clock(fn _, _ -> {:ok, nil} end, []) end
    assert_raise ArgumentError, fn -> Capability.musical_clock(fn _ -> {:ok, nil} end, cost: 1) end

    # The Core refuses `wait` as any other Capability's Operation.
    wait =
      Capability.from_functions("later", %{"wait" => {[mode: :suspending, args: ["any"]], fn _, _ -> {:ok, nil} end}})

    assert {:error, %HostError{code: "invalid value"}} = NorthTalk.define_capability(owner, wait)
  end

  test "a pending musical wait restores onto the restored Group's own clock" do
    {owner, clock} = owner()
    group = NorthTalk.new_group!(owner, "g", musical_clock: clock)
    NorthTalk.load!(group, "s", @song, [])
    {:ok, _} = NorthTalk.deliver(group, "s", "go")
    assert_receive {:wait, _, _}
    save = NorthTalk.save!(group)

    # The caller's Grants never stand in for the musical clock.
    {other, _} = owner()

    assert {:ok,
            %Restored{
              group: copy,
              pending: [%PendingCall{call: call, script: "s", grant: "musical-clock", operation: "wait"}]
            }} =
             NorthTalk.restore(other, "copy", save,
               musical_clock: NorthTalk.grant!(other, "musical-clock"),
               grants: fn _, _ -> raise "asked for a Grant" end
             )

    :ok = NorthTalk.settle(copy, call, :reissue)
    assert_receive {:wait, count, %Call{group: %Group{owner: ^other, name: "copy"}, id: ^call}}
    assert NorthTalk.Value.encode(count) == %{"$quantity" => ["8", "bar"]}
    :ok = NorthTalk.answer(other, {:wait, "copy", call}, nil)
    assert %{"outcome" => "completed", "result" => 1} = run_end("copy")

    # Without one, the clock restores revoked.
    {:ok, %Restored{group: bare, pending: [%{call: call}]}} = NorthTalk.restore(other, "bare", save)
    :ok = NorthTalk.settle(bare, call, :reissue)
    assert %{"error" => %{"code" => "capability revoked"}} = run_end("bare")
  end
end
