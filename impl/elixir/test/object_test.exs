defmodule NorthTalk.ObjectTest do
  use ExUnit.Case, async: true
  alias NorthTalk.{HostError, Object, ObjectKind, Result, ScriptError}

  defp owner do
    start_supervised!({NorthTalk, [reports_to: self()]}, id: make_ref())
  end

  # A door's state lives in an Agent: Elixir terms can't change in place, so
  # `native` names where the state is.
  defp door_kind(test) do
    ObjectKind.new("door",
      props: %{
        "isLocked" => [
          shape: "boolean",
          get: fn agent -> {:ok, Agent.get(agent, & &1.locked)} end,
          set: fn agent, v -> Agent.update(agent, &%{&1 | locked: v}) end
        ],
        "name" => [shape: "text", get: fn agent -> {:ok, Agent.get(agent, & &1.name)} end],
        "slow" => [
          get: fn _ ->
            send(test, {:slow, self()})
            Process.sleep(20)
            {:ok, 7}
          end
        ],
        "jammed" => [get: fn _ -> {:error, %{code: "jammed", message: "stuck"}} end]
      },
      elements: [
        shape: %{"object" => "key"},
        count: fn agent -> {:ok, length(Agent.get(agent, & &1.keys))} end,
        at: fn agent, i ->
          keys = Agent.get(agent, & &1.keys)
          {:ok, if(i > 0, do: Enum.at(keys, i - 1), else: Enum.at(keys, i))}
        end,
        find: fn agent, name -> {:ok, Enum.find(Agent.get(agent, & &1.keys), &(&1.id == name))} end
      ]
    )
  end

  defp key_kind, do: ObjectKind.new("key", props: %{"id" => [shape: "text", get: fn id -> {:ok, id} end]})

  defp door(group, id, keys \\ []) do
    {:ok, agent} = Agent.start_link(fn -> %{locked: false, name: id, keys: keys} end)
    # The collection's Shape names the key Kind, so it is defined first.
    :ok = NorthTalk.define_object_kind(group.owner, key_kind())
    {NorthTalk.object!(group, door_kind(self()), id, agent), agent}
  end

  test "a Script reads and sets a Host Object's properties" do
    group = NorthTalk.new_group!(owner(), "g", [])
    {front, agent} = door(group, "front")

    NorthTalk.load!(
      group,
      "s",
      """
      on lock d
        set the isLocked of d to true
        return the name of d & " " & the isLocked of d
      end lock
      """,
      []
    )

    assert {:ok, %Result{value: "front true"}} = NorthTalk.request(group, "s", "lock", [front])
    assert Agent.get(agent, & &1.locked)
  end

  test "a property need crosses the binary callback envelope too" do
    owner = start_supervised!({NorthTalk, [binary_callbacks: true]}, id: make_ref())
    group = NorthTalk.new_group!(owner, "g", [])
    {front, _} = door(group, "front")
    NorthTalk.load!(group, "s", "on peek d\n  return the name of d\nend peek\n", [])
    assert {:ok, %Result{value: "front"}} = NorthTalk.request(group, "s", "peek", [front])
  end

  test "a property need is served from a Task, and its failure reaches the Script" do
    group = NorthTalk.new_group!(owner(), "g", [])
    {front, _} = door(group, "front")

    NorthTalk.load!(
      group,
      "s",
      """
      on slow d
        return the slow of d
      end slow
      on jam d
        return the jammed of d
      end jam
      on name d
        set the name of d to "back"
      end name
      """,
      []
    )

    assert {:ok, %Result{value: 7}} = NorthTalk.request(group, "s", "slow", [front])
    assert_received {:slow, pid}
    refute pid == self()

    assert {:error, %ScriptError{error: %{"code" => "jammed", "capability" => "door"}}} =
             NorthTalk.request(group, "s", "jam", [front])

    assert {:error, %ScriptError{}} = NorthTalk.request(group, "s", "name", [front])
  end

  test "an Element lookup goes through the Kind's collection" do
    owner = owner()
    group = NorthTalk.new_group!(owner, "g", [])
    :ok = NorthTalk.define_object_kind(owner, key_kind())
    brass = NorthTalk.object!(group, key_kind(), "brass", "brass")
    iron = NorthTalk.object!(group, key_kind(), "iron", "iron")
    {front, _} = door(group, "front", [brass, iron])

    NorthTalk.load!(
      group,
      "s",
      """
      on keys d
        return [the number of elements of d, the id of element "iron" of d, the id of the last element of d, element "tin" of d]
      end keys
      """,
      []
    )

    assert {:ok, %Result{value: [2, "iron", "iron", nil]}} = NorthTalk.request(group, "s", "keys", [front])
  end

  test "a delivery reaches the Owning Script of a Host Object" do
    group = NorthTalk.new_group!(owner(), "g", [])
    {front, _} = door(group, "front")

    NorthTalk.load!(group, "s", "on knock\n  return the name of me\nend knock\n", owner: front)
    assert {:ok, %Result{value: "front"}} = NorthTalk.request(group, front, "knock")
  end

  test "handles: ids, lookup, Groups and disposal" do
    owner = owner()
    group = NorthTalk.new_group!(owner, "g", [])
    other = NorthTalk.new_group!(owner, "h", [])
    {front, agent} = door(group, "front")

    assert %Object{kind: "door", id: "front", group: "g"} = front
    assert {:ok, ^front} = NorthTalk.object_by_id(group, "door", "front")
    assert :error = NorthTalk.object_by_id(group, "door", "back")

    assert {:error, %HostError{code: "duplicate object id"}} =
             NorthTalk.object(group, door_kind(self()), "front", agent)

    assert {:error, %HostError{code: "wrong group"}} = NorthTalk.deliver(other, front, "knock")

    {back, _} = door(group, "back")
    assert :ok = NorthTalk.set_parent(group, back, front)
    assert :ok = NorthTalk.set_parent(group, back, nil)

    NorthTalk.load!(group, "s", "on peek d\n  return the name of d\nend peek\n", [])
    assert :ok = NorthTalk.dispose(group, front)
    assert {:error, %ScriptError{error: %{"code" => "object gone"}}} = NorthTalk.request(group, "s", "peek", [front])

    assert {:error, %HostError{code: "duplicate object id"}} =
             NorthTalk.object(group, door_kind(self()), "front", agent)
  end

  test "another Kind under a defined name is refused" do
    owner = owner()
    :ok = NorthTalk.define_object_kind(owner, key_kind())
    assert :ok = NorthTalk.define_object_kind(owner, key_kind())

    assert {:error, %HostError{code: "invalid value"}} =
             NorthTalk.define_object_kind(owner, ObjectKind.new("key", props: %{}))
  end

  test "a saved Host Object restores live when the resolver recognises it" do
    owner = owner()
    group = NorthTalk.new_group!(owner, "g", [])
    {front, agent} = door(group, "front")
    {back, _} = door(group, "back")

    NorthTalk.load!(
      group,
      "s",
      """
      script variable doors = []
      on keep d
        put d after doors
      end keep
      on names
        put [] into out
        repeat for each d in doors
          put the name of d after out
        end repeat
        return out
      end names
      """,
      []
    )

    {:ok, _} = NorthTalk.request(group, "s", "keep", [front])
    {:ok, _} = NorthTalk.request(group, "s", "keep", [back])
    save = NorthTalk.save!(group)

    resolve = fn
      "door", "front" -> {:ok, agent}
      _, _ -> :error
    end

    restored = NorthTalk.restore!(owner, "r", save, resolve_object: resolve)
    assert restored.disposed == [["door", "back"]]
    assert {:ok, %Object{id: "front", group: "r"}} = NorthTalk.object_by_id(restored.group, "door", "front")
    assert {:error, %ScriptError{error: %{"code" => "object gone"}}} = NorthTalk.request(restored.group, "s", "names")
  end
end
