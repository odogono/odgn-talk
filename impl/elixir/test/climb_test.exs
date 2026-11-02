defmodule NorthTalk.ClimbTest do
  use ExUnit.Case, async: true
  alias NorthTalk.{ObjectKind, Result, ScriptError}

  defp group do
    owner = start_supervised!({NorthTalk, [reports_to: self()]}, id: make_ref())
    NorthTalk.new_group!(owner, "g", [])
  end

  defp kind, do: ObjectKind.new("atom", props: %{"name" => [shape: "text", get: fn n -> {:ok, n} end]})

  # A room holding a box: a message to the box climbs to the room.
  defp room_and_box(group) do
    room = NorthTalk.object!(group, kind(), "room", "room")
    box = NorthTalk.object!(group, kind(), "box", "box", parent: room)
    {room, box}
  end

  test "a Request climbs a Message Path to the Handler that answers it" do
    group = group()
    {room, box} = room_and_box(group)
    NorthTalk.load!(group, "box", "on look\n  pass look\nend look\n", owner: box)
    NorthTalk.load!(group, "room", "on look\n  return \"seen from \" & the name of me\nend look\n", owner: room)

    assert {:ok, %Result{value: "seen from room"}} = NorthTalk.request(group, box, "look")
  end

  test "a Request that climbs past every Handler ends unhandled" do
    group = group()
    {room, box} = room_and_box(group)
    NorthTalk.load!(group, "box", "on look\n  pass look\nend look\n", owner: box)
    NorthTalk.load!(group, "room", "on other\nend other\n", owner: room)

    assert {:error, %ScriptError{outcome: "unhandled"}} = NorthTalk.request(group, box, "look")
    assert {:error, %ScriptError{outcome: "unhandled"}} = NorthTalk.request(group, room, "nobody")
  end

  test "a reported run end leaves out climbed" do
    group = group()
    {room, box} = room_and_box(group)
    NorthTalk.load!(group, "box", "on look\n  pass look\nend look\n", owner: box)
    NorthTalk.load!(group, "room", "on look\n  return 1\nend look\n", owner: room)
    {:ok, _} = NorthTalk.request(group, box, "look")

    assert_receive {:north_talk, _, %{"kind" => "run end", "script" => "box"} = report}
    refute Map.has_key?(report, "climbed")
  end

  test "a Broadcast reaches every Script that wants it" do
    group = group()
    test = self()

    tell =
      NorthTalk.Capability.from_functions("bell", %{
        "note" => {[args: ["any"]], fn [x], _ -> send(test, x) && {:ok, nil} end}
      })

    :ok = NorthTalk.define_capability!(group.owner, tell)
    grant = NorthTalk.grant!(group.owner, "bell", [])

    for name <- ["a", "b"] do
      NorthTalk.load!(group, name, "on ring n\n  ask bell to note \"#{name}\" & n\nend ring\n",
        grants: %{"bell" => grant}
      )
    end

    NorthTalk.load!(group, "c", "on other\nend other\n", [])

    assert {:ok, id} = NorthTalk.broadcast(group, "ring", [1])
    assert is_binary(id)
    assert_receive "a1"
    assert_receive "b1"
  end
end
