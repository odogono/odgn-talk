defmodule NorthTalk.FunctionTest do
  use ExUnit.Case, async: true
  alias NorthTalk.{Bytes, CivilDate, HostError, Instant, Pattern, Quantity, Range, Result, ScriptError}

  @source """
  on echo v
    return v
  end echo

  on adder n
    return given x: x + n
  end adder

  on apply f, x
    return f(x)
  end apply
  """

  setup do
    owner = start_supervised!({NorthTalk, []})
    group = NorthTalk.new_group!(owner, "g", [])
    "s" = NorthTalk.load!(group, "s", @source, [])
    %{owner: owner, group: group}
  end

  test "every data kind survives a round trip through the Core", %{group: group} do
    for value <- [
          nil,
          false,
          9_007_199_254_740_993,
          Decimal.new("-0.50"),
          "é",
          Bytes.new(<<0, 1, 2, 255>>),
          [1, ["x"]],
          NorthTalk.Map.new([{"z", 1}, {"$a", 2}]),
          Quantity.new(Decimal.new("2.50"), "GBP"),
          Quantity.new(3, "day"),
          Range.new(1, 5),
          %Instant{unix_us: 1_704_164_645_123_456},
          %CivilDate{year: 2024, month: 1, day: 2},
          %CivilDate{year: 2024, month: 1, day: 2, hour: 3, minute: 4, second: 5, microsecond: 600_000},
          Pattern.new(~s(<"ID-", 4 digits>))
        ] do
      expected = if value == "é", do: "é", else: value
      assert {:ok, %Result{value: ^expected}} = NorthTalk.request(group, "s", "echo", [value])
    end
  end

  test "the Core refuses a Unit not in normal form", %{group: group} do
    assert {:error, %HostError{code: "invalid value"}} =
             NorthTalk.request(group, "s", "echo", [Quantity.new(3, "days")])
  end

  test "a Function Value is captured, called and passed back", %{group: group} do
    {:ok, %Result{value: %NorthTalk.Function{home: "s", display: display} = add2}} =
      NorthTalk.request(group, "s", "adder", [2])

    assert display =~ "function"
    assert {:ok, %Result{value: 5}} = NorthTalk.call(group, add2, [3])
    assert {:ok, %Result{value: 12}} = NorthTalk.call(group, add2, [10])
    assert {:ok, %Result{value: 9}} = NorthTalk.request(group, "s", "apply", [add2, 7])

    assert {:error, %ScriptError{outcome: "errored", error: %{"code" => "wrong arity"}}} =
             NorthTalk.call(group, add2, [1, 2])
  end

  test "a released handle can't be used, and releasing is idempotent", %{group: group} do
    {:ok, %Result{value: f}} = NorthTalk.request(group, "s", "adder", [1])
    assert :ok = NorthTalk.release(f)
    assert :ok = NorthTalk.release(f)
    assert {:error, %HostError{code: "function released"}} = NorthTalk.call(group, f, [1])
    assert {:error, %HostError{code: "function released"}} = NorthTalk.request(group, "s", "echo", [[f]])
  end

  test "a handle is refused in another Group", %{owner: owner, group: group} do
    other = NorthTalk.new_group!(owner, "h", [])
    "s" = NorthTalk.load!(other, "s", @source, [])
    {:ok, %Result{value: f}} = NorthTalk.request(group, "s", "adder", [1])

    assert {:error, %HostError{code: "wrong group"}} = NorthTalk.call(other, f, [1])

    assert {:error, %HostError{code: "wrong group"}} =
             NorthTalk.request(other, "s", "echo", [NorthTalk.Map.new([{"f", f}])])

    other_owner = start_supervised!({NorthTalk, []}, id: :other)
    g2 = NorthTalk.new_group!(other_owner, "g", [])
    assert {:error, %HostError{code: "wrong group"}} = NorthTalk.call(g2, f, [1])
  end

  test "closing the Group releases its handles", %{owner: owner, group: group} do
    {:ok, %Result{value: f}} = NorthTalk.request(group, "s", "adder", [1])
    other = NorthTalk.new_group!(owner, "h", [])
    "s" = NorthTalk.load!(other, "s", @source, [])
    {:ok, %Result{value: kept}} = NorthTalk.request(other, "s", "adder", [1])

    assert :ok = NorthTalk.close_group(group)
    assert {:error, %HostError{code: "group closed"}} = NorthTalk.call(group, f, [1])
    assert {:error, %HostError{code: "group closed"}} = NorthTalk.request(group, "s", "echo", [1])
    assert {:ok, %Result{value: 2}} = NorthTalk.call(other, kept, [1])
  end

  test "a handle of a closed owner is an error", %{owner: owner, group: group} do
    {:ok, %Result{value: f}} = NorthTalk.request(group, "s", "adder", [1])
    :ok = stop_supervised(NorthTalk)
    refute Process.alive?(owner)
    assert {:error, %HostError{code: "instance closed"}} = NorthTalk.call(group, f, [1])
    assert :ok = NorthTalk.release(f)
  end
end
