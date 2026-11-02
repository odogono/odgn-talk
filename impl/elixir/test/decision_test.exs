defmodule NorthTalk.DecisionTest do
  use ExUnit.Case, async: true
  alias NorthTalk.{ObjectKind, Verdict}

  defp group do
    owner = start_supervised!({NorthTalk, [reports_to: self()]}, id: make_ref())
    NorthTalk.new_group!(owner, "g", [])
  end

  @guard """
  on move place, deciding
    if place is "lava" then
      veto "too hot"
    end if
  end move
  """

  test "a Script vetoes a Decision, and allows another" do
    group = group()
    NorthTalk.load!(group, "guard", @guard, [])

    {:ok, pending} = NorthTalk.decide(group, "guard", "move", ["lava"])

    assert {:ok, %Verdict{verdict: :vetoed, vetoes: [%{script: "guard", reason: "too hot", run: run}]}} =
             NorthTalk.await(pending)

    assert is_binary(run)

    assert {:ok, %Verdict{verdict: :allowed, vetoes: []}} =
             NorthTalk.await(NorthTalk.decide!(group, "guard", "move", ["grass"]))
  end

  test "a Decision to a Host Object climbs to the Script that vetoes it" do
    group = group()
    kind = ObjectKind.new("atom")
    room = NorthTalk.object!(group, kind, "room", nil)
    box = NorthTalk.object!(group, kind, "box", nil, parent: room)
    NorthTalk.load!(group, "box", "on move place, deciding\n  pass move\nend move\n", owner: box)
    NorthTalk.load!(group, "room", @guard, owner: room)

    assert {:ok, %Verdict{verdict: :vetoed, vetoes: [%{script: "room"}]}} =
             NorthTalk.await(NorthTalk.decide!(group, box, "move", ["lava"]))

    # Past the end of its Message Path, a Decision is allowed.
    assert {:ok, %Verdict{verdict: :allowed}} = NorthTalk.await(NorthTalk.decide!(group, box, "jump", []))
  end

  test "a Run that errors before it seals leaves the Decision undecided" do
    group = group()
    NorthTalk.load!(group, "s", "on move place, deciding\n  put 1 / 0 into x\nend move\n", [])

    assert {:ok, %Verdict{verdict: :undecided, undecided: [%{script: "s", outcome: outcome}]}} =
             NorthTalk.await(NorthTalk.decide!(group, "s", "move", [1]))

    assert is_binary(outcome)
  end

  test "a Broadcast Decision is vetoed when any recipient vetoes" do
    group = group()
    NorthTalk.load!(group, "guard", @guard, [])
    NorthTalk.load!(group, "calm", "on move place, deciding\nend move\n", [])

    assert {:ok, %Verdict{verdict: :vetoed, vetoes: [%{script: "guard"}]}} =
             NorthTalk.await(NorthTalk.decide_broadcast!(group, "move", ["lava"]))

    assert {:ok, %Verdict{verdict: :allowed}} = NorthTalk.await(NorthTalk.decide_broadcast!(group, "move", ["grass"]))
    assert {:ok, %Verdict{verdict: :allowed}} = NorthTalk.await(NorthTalk.decide_broadcast!(group, "nobody", []))
  end
end
