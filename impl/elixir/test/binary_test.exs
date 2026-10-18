defmodule NorthTalk.BinaryTest do
  use ExUnit.Case, async: true
  alias NorthTalk.{Binary, HostError}

  @vectors "test/fixtures/request_pump_fields.txt"
           |> File.read!()
           |> String.split("\n", trim: true)
           |> Enum.reject(&String.starts_with?(&1, "#"))
           |> Enum.chunk_every(2)

  defp json(text), do: Jason.decode!(text, objects: :ordered_objects, floats: :decimals)
  defp plain(%Jason.OrderedObject{values: values}), do: Map.new(values, fn {k, v} -> {k, plain(v)} end)
  defp plain(list) when is_list(list), do: Enum.map(list, &plain/1)
  defp plain(other), do: other

  test "frames encode to the bytes TS writes, and decode back to their JSON form" do
    for [text, hex] <- @vectors do
      bytes = Base.decode16!(hex, case: :lower)
      assert Binary.encode(json(text)) == bytes
      decoded = Binary.decode(bytes)
      assert Binary.encode(decoded) == bytes
      # Decoding adds `m` to an input; a value-free completion keeps its shape.
      assert plain(decoded) == plain(json(text))
    end
  end

  test "every specialized Report keeps its kind" do
    kinds = [
      "run end",
      "run started",
      "run discarded",
      "run accounting",
      "causal work",
      "stop",
      "unhandled",
      "call failed",
      "effect failure",
      "decided",
      "host error",
      "charge result"
    ]

    frame = %{
      "ref" => 1,
      "delivery" => "d1",
      "token" => 1,
      "ok" => %{"state" => "idle", "fuelUsed" => 0, "reports" => Enum.map(kinds, &%{"kind" => &1})}
    }

    assert %{"ok" => %{"reports" => reports}} = plain(Binary.decode(Binary.encode(frame)))
    assert Enum.map(reports, & &1["kind"]) == kinds
  end

  test "deep Values have no fixed nesting limit" do
    deep = Enum.reduce(1..20_000, 0, fn _, v -> [v] end)
    frame = %{"m" => "call-pump", "ref" => 1, "group" => "g", "token" => 1, "fn" => nil, "args" => [deep]}
    assert %{"args" => [^deep]} = plain(Binary.decode(Binary.encode(frame)))
  end

  test "malformed frames are refused" do
    good = Binary.encode(%{"ref" => 1, "err" => %{"kind" => "host error", "code" => "x", "detail" => "y"}})
    <<prefix::binary-size(5), _tag, rest::binary>> = good

    for bad <- [
          <<>>,
          "{}",
          good <> <<0>>,
          binary_part(good, 0, byte_size(good) - 1),
          <<prefix::binary, 0x7F, rest::binary>>,
          <<"NTB", 2, 1, 0x81, rest::binary>>,
          <<"NTB", 1, 0, 0x81, rest::binary>>,
          # A list one field short.
          <<prefix::binary, 0x81, 6, 5, binary_part(rest, 2, byte_size(rest) - 3)::binary>>,
          # The ref as an overlong LEB128.
          <<prefix::binary, 0x81, 6, 6, 3, 0x81, 0x00, binary_part(rest, 4, byte_size(rest) - 4)::binary>>
        ] do
      assert_raise HostError, fn -> Binary.decode(bad) end
    end
  end

  test "non-canonical Values are refused" do
    frame = fn arg ->
      <<"NTB", 1, 1, 0x05, 6, 9, 3, 1, 0x12, 1, "g", 3, 1, 0, 6, 1>> <> arg <> <<0, 0, 0, 0>>
    end

    assert %{"args" => [1]} = plain(Binary.decode(frame.(<<3, 1>>)))

    for bad <- [
          # A decimal item for a number an integer item holds.
          <<4, 1, "1">>,
          # Negative zero.
          <<0x10, 0>>,
          # Text not in NFC.
          <<5, 3, "e", 0xCC, 0x81>>,
          # Protocol text in a Value.
          <<0x12, 1, "x">>,
          # A repeated Map key.
          <<7, 2, 5, 1, "a", 0, 5, 1, "a", 0>>,
          # Function metadata, not negotiated.
          <<0x13, 6, 5, 0, 5, 0, 5, 0, 0, 3, 0, 3, 0>>,
          # A Core-error Map, not negotiated.
          <<0x11, 0>>
        ] do
      assert_raise HostError, fn -> Binary.decode(frame.(bad)) end
    end
  end

  test "a binary frame is told apart before any JSON reading" do
    assert Binary.binary?(<<"NTB", 1, 1>>)
    refute Binary.binary?(~s({"m":"hello"}))
  end
end
