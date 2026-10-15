defmodule NorthTalk.ValueTest do
  use ExUnit.Case, async: true
  alias NorthTalk.{HostError, Value}

  defp roundtrip(term) do
    term
    |> Value.encode()
    |> Jason.encode!()
    |> Jason.decode!(objects: :ordered_objects, floats: :decimals)
    |> Value.decode()
  end

  test "numbers keep their precision and trailing zeros" do
    assert Value.encode(3) == 3
    assert Value.encode(Decimal.new("1.0")) == %{"$dec" => "1.0"}
    assert Value.encode(Decimal.new("1E2")) == 100
    assert Value.encode(Decimal.new("-0.00")) == %{"$dec" => "0.00"}
    assert Value.encode(9_007_199_254_740_993) == %{"$dec" => "9007199254740993"}
    assert roundtrip(9_007_199_254_740_993) == 9_007_199_254_740_993
    assert Decimal.to_string(roundtrip(Decimal.new("2.50"))) == "2.50"
  end

  test "floats and atoms are refused" do
    assert_raise HostError, ~r/float/, fn -> Value.encode(1.5) end
    assert_raise HostError, fn -> Value.encode(:ok) end
    assert_raise HostError, fn -> Value.encode(Decimal.new("NaN")) end
  end

  test "text is normalised to NFC and must be UTF-8" do
    assert Value.encode("é") == "é"
    assert_raise HostError, ~r/UTF-8/, fn -> Value.encode(<<0xFF>>) end
  end

  test "maps keep their order; plain maps need at most one key" do
    map = NorthTalk.Map.new([{"z", 1}, {"a", 2}])
    assert Jason.encode!(Value.encode(map)) == ~s({"z":1,"a":2})
    assert roundtrip(map) == map
    assert roundtrip(%{"k" => [1, nil, true]}) == NorthTalk.Map.new([{"k", [1, nil, true]}])
    assert_raise HostError, ~r/NorthTalk.Map/, fn -> Value.encode(%{"a" => 1, "b" => 2}) end
    assert_raise HostError, ~r/text/, fn -> Value.encode(%{a: 1}) end
  end

  test "a map with a $ key uses $map" do
    map = NorthTalk.Map.new([{"$x", 1}])
    assert Value.encode(map) == %{"$map" => [["$x", 1]]}
    assert roundtrip(map) == map
  end
end
