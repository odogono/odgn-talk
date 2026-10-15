defmodule NorthTalk.Value do
  @moduledoc """
  Converts between Elixir terms and the Value Encoding
  (spec/09-embedding.md#json-and-the-value-encoding).

  | NorthTalk | Elixir |
  | --- | --- |
  | Nothing | `nil` |
  | boolean | `true`, `false` |
  | number | an integer when it has no fraction digits, otherwise a `Decimal` |
  | text | a UTF-8 binary, normalised to NFC on input |
  | list | a list |
  | map | `NorthTalk.Map`; a plain map with at most one key on input |

  Floats are refused, since they can't hold a decimal exactly, and so are
  atoms other than `nil`, `true` and `false`. Decoding never creates atoms.
  """

  @max_plain 9_007_199_254_740_992

  @doc "Encodes `term`. Raises `NorthTalk.HostError` with code `invalid value`."
  def encode(nil), do: nil
  def encode(b) when is_boolean(b), do: b
  def encode(n) when is_integer(n) and abs(n) < @max_plain, do: n
  def encode(n) when is_integer(n), do: %{"$dec" => Integer.to_string(n)}

  def encode(%Decimal{coef: coef} = d) when is_integer(coef) do
    if d.exp >= 0,
      do: encode(d.sign * d.coef * Integer.pow(10, d.exp)),
      else: %{"$dec" => Decimal.to_string(%{d | sign: if(coef == 0, do: 1, else: d.sign)}, :normal)}
  end

  def encode(%Decimal{} = d), do: invalid("#{Decimal.to_string(d)} is not a finite number")
  def encode(f) when is_float(f), do: invalid("#{f} is a float; use an integer or a Decimal")

  def encode(text) when is_binary(text) do
    if String.valid?(text),
      do: :unicode.characters_to_nfc_binary(text),
      else: invalid("text must be UTF-8")
  end

  def encode(list) when is_list(list), do: Enum.map(list, &encode/1)
  def encode(%NorthTalk.Map{entries: entries}), do: encode_map(entries)

  def encode(map) when is_map(map) and not is_struct(map) and map_size(map) <= 1,
    do: encode_map(Map.to_list(map))

  def encode(map) when is_map(map) and not is_struct(map),
    do: invalid("a map with more than one key has no order; use NorthTalk.Map")

  def encode(other), do: invalid("#{inspect(other)} has no NorthTalk form")

  defp encode_map(entries) do
    entries = Enum.map(entries, fn {k, v} -> {key(k), encode(v)} end)

    if Enum.any?(entries, fn {k, _} -> String.starts_with?(k, "$") end),
      do: %{"$map" => Enum.map(entries, fn {k, v} -> [k, v] end)},
      else: Jason.OrderedObject.new(entries)
  end

  defp key(k) when is_binary(k), do: encode(k)
  defp key(k), do: invalid("map keys must be text, not #{inspect(k)}")

  @doc """
  Decodes a value the Core sent, read with `Jason.decode(objects:
  :ordered_objects, floats: :decimals)`.
  """
  def decode(nil), do: nil
  def decode(b) when is_boolean(b), do: b
  def decode(n) when is_integer(n), do: n
  def decode(%Decimal{} = d), do: d
  def decode(text) when is_binary(text), do: text
  def decode(list) when is_list(list), do: Enum.map(list, &decode/1)

  def decode(%Jason.OrderedObject{values: [{"$dec", text}]}) do
    if String.contains?(text, "."), do: Decimal.new(text), else: String.to_integer(text)
  end

  def decode(%Jason.OrderedObject{values: [{"$map", pairs}]}),
    do: NorthTalk.Map.new(for [k, v] <- pairs, do: {k, decode(v)})

  def decode(%Jason.OrderedObject{values: [{"$" <> _ = tag, _}]}),
    do: invalid("the #{tag} value kind isn't supported yet")

  def decode(%Jason.OrderedObject{values: values}),
    do: NorthTalk.Map.new(for {k, v} <- values, do: {k, decode(v)})

  defp invalid(detail), do: raise(NorthTalk.HostError, code: "invalid value", detail: detail)
end
