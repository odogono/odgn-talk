defmodule NorthTalk.RestoreTest do
  use ExUnit.Case, async: true
  alias NorthTalk.{Capability, Group, HostError, PendingCall, Restored, Result}

  @source """
  script variable n = 5
  on fetch x
    ask api to fetch x and wait
    return it + n
  end fetch

  on peek
    return n
  end peek
  """

  # A suspending Operation that tells the test of each call and defers it.
  defp api(test) do
    Capability.from_functions("api", %{
      "fetch" =>
        {[mode: :suspending, args: ["number"], result: "number"],
         fn [x], call ->
           send(test, {:fetch, x, call.id})
           {:defer, {:fetch, call.group.name, call.id}}
         end}
    })
  end

  defp owner(opts \\ []) do
    owner = start_supervised!({NorthTalk, [reports_to: self()] ++ opts}, id: make_ref())
    :ok = NorthTalk.define_capability!(owner, api(self()))
    {owner, NorthTalk.grant!(owner, "api")}
  end

  # A save of a Group whose Run waits on one pending call.
  defp saved_with_pending do
    {owner, grant} = owner()
    group = NorthTalk.new_group!(owner, "g", [])
    NorthTalk.load!(group, "s", @source, grants: %{"api" => grant})
    {:ok, _} = NorthTalk.deliver(group, "s", "fetch", [9])
    assert_receive {:fetch, 9, _}
    {owner, grant, NorthTalk.save!(group)}
  end

  defp run_end(name) do
    receive do
      {:north_talk, %Group{name: ^name}, %{"kind" => "run end"} = report} -> report
    after
      2_000 -> flunk("no run end in #{name}")
    end
  end

  test "a saved Group restores with its variables", %{} do
    {owner, _grant} = owner()
    group = NorthTalk.new_group!(owner, "g", [])
    NorthTalk.load!(group, "s", "script variable n = 3\non bump\n  put n + 1 into n\n  return n\nend bump\n", [])
    {:ok, %Result{value: 4}} = NorthTalk.request(group, "s", "bump")
    save = NorthTalk.save!(group)
    assert is_binary(save)

    assert {:ok, %Restored{group: copy, variables_only: false, pending: []}} = NorthTalk.restore(owner, "copy", save)
    assert {:ok, %Result{value: 5}} = NorthTalk.request(copy, "s", "bump")
    assert {:ok, %Result{value: 5}} = NorthTalk.request(group, "s", "bump")
  end

  test "a pending call is answered after restore, and only then pumped" do
    {owner, grant, save} = saved_with_pending()

    assert {:ok,
            %Restored{
              group: copy,
              pending: [%PendingCall{call: call, script: "s", grant: "api", operation: "fetch", args: [9]}]
            }} =
             NorthTalk.restore(owner, "copy", save, grants: %{{"s", "api"} => grant})

    refute_receive {:north_talk, %Group{name: "copy"}, %{"kind" => "run end"}}, 100
    assert :ok = NorthTalk.settle(copy, call, {:answer, 30})
    assert %{"result" => 35} = run_end("copy")
    assert {:error, %HostError{code: "unknown call"}} = NorthTalk.settle(copy, call, {:answer, 1})
  end

  test "a reissued call runs its callback again under the same id" do
    {owner, grant, save} = saved_with_pending()

    {:ok, %Restored{group: copy, pending: [%{call: call}]}} =
      NorthTalk.restore(owner, "copy", save, grants: fn "s", "api" -> grant end)

    :ok = NorthTalk.settle(copy, call, :reissue)
    assert_receive {:fetch, 9, ^call}
    :ok = NorthTalk.answer(owner, {:fetch, "copy", call}, 1)
    assert %{"result" => 6} = run_end("copy")
  end

  test "an adopted call is settled later under the Host's ref" do
    {owner, grant, save} = saved_with_pending()

    {:ok, %Restored{group: copy, pending: [%{call: call}]}} =
      NorthTalk.restore(owner, "copy", save, grants: %{{"s", "api"} => grant})

    :ok = NorthTalk.settle(copy, call, {:adopt, :mine})
    :ok = NorthTalk.fail(owner, :mine, "gone")
    assert %{"outcome" => "errored", "error" => %{"code" => "gone"}} = run_end("copy")
  end

  test "a call left unsettled is lost at the first Pump" do
    {owner, grant, save} = saved_with_pending()
    {:ok, %Restored{group: copy}} = NorthTalk.restore(owner, "copy", save, grants: %{{"s", "api"} => grant})
    {:ok, _} = NorthTalk.pump(copy)
    assert %{"error" => %{"code" => "call lost"}} = run_end("copy")
  end

  test "a Grant not given restores revoked" do
    {owner, _grant, save} = saved_with_pending()
    {:ok, %Restored{group: copy, pending: [%{call: call}]}} = NorthTalk.restore(owner, "copy", save)
    :ok = NorthTalk.settle(copy, call, :reissue)
    assert %{"error" => %{"code" => "capability revoked"}} = run_end("copy")
  end

  test "a save restores in another instance, whose Grants it rebinds" do
    {_owner, _grant, save} = saved_with_pending()
    {other, grant} = owner()

    {:ok, %Restored{group: copy, pending: [%{call: call}]}} =
      NorthTalk.restore(other, "g", save, grants: %{{"s", "api"} => grant})

    :ok = NorthTalk.settle(copy, call, {:answer, 1})
    assert %{"result" => 6} = run_end("g")
  end

  test "a save can't be taken with a scope open, nor restored from other bytes" do
    {owner, _} = owner(drive: :manual)

    cap =
      Capability.from_functions(
        "db",
        %{
          "begin" => {[result: "nothing", scope: %{opens: "tx", abandon: "rollback"}], fn [], _ -> {:ok, nil} end},
          "rollback" => {[result: "nothing", scope: %{closes: "tx"}], fn [], _ -> {:ok, nil} end}
        }
      )

    :ok = NorthTalk.define_capability!(owner, cap)
    group = NorthTalk.new_group!(owner, "g", [])
    source = "on go\n  ask db to begin\n  repeat forever\n  end repeat\nend go\n"
    NorthTalk.load!(group, "s", source, grants: %{"db" => NorthTalk.grant!(owner, "db")})
    {:ok, _} = NorthTalk.deliver(group, "s", "go")
    {:ok, %{state: "sliced"}} = NorthTalk.pump(group, fuel_slice: 40)
    assert {:error, %HostError{code: "effects pending"}} = NorthTalk.save(group)
    assert {:error, %HostError{code: "invalid save"}} = NorthTalk.restore(owner, "copy", "not a save")
    assert {:ok, %Restored{}} = NorthTalk.restore(owner, "empty", NorthTalk.save!(NorthTalk.new_group!(owner, "e", [])))
  end
end
