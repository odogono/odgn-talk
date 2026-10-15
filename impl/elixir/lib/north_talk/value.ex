defmodule NorthTalk.Value do
  @moduledoc """
  Basic Elixir values at the Message Layer boundary. Numbers decode as `Decimal`.
  Floats and maps with more than one key are refused; ordered maps and the
  remaining tagged value kinds belong to a later API slice.
  """
  alias NorthTalk.HostError
  @safe_integer 9_007_199_254_740_992

  @doc false
  def safe_integer, do: @safe_integer

  def encode(nil), do: nil
  def encode(value) when is_boolean(value), do: value
  def encode(value) when is_integer(value) and abs(value) < @safe_integer, do: value
  def encode(value) when is_integer(value), do: %{"$dec" => Integer.to_string(value)}

  def encode(%Decimal{coef: coef} = value) when is_integer(coef) do
    text = Decimal.to_string(value, :normal)
    text = if coef == 0, do: String.trim_leading(text, "-"), else: text

    case Integer.parse(text) do
      {integer, ""} when abs(integer) < @safe_integer -> integer
      _ -> %{"$dec" => text}
    end
  end

  def encode(value) when is_binary(value) do
    if String.valid?(value), do: String.normalize(value, :nfc), else: invalid("text must be UTF-8")
  end

  def encode(value) when is_list(value), do: Enum.map(value, &encode/1)

  def encode(value) when is_map(value) and not is_struct(value) and map_size(value) <= 1 do
    case Map.to_list(value) do
      [] ->
        %{}

      [{key, item}] when is_binary(key) ->
        key = encode(key)
        if String.starts_with?(key, "$"), do: %{"$map" => [[key, encode(item)]]}, else: %{key => encode(item)}

      _ ->
        invalid("map keys must be text")
    end
  end

  def encode(_), do: invalid("expected a basic value; floats and multi-key maps are unsupported")

  def decode(nil), do: nil
  def decode(value) when is_boolean(value) or is_binary(value), do: value
  def decode(value) when is_integer(value), do: Decimal.new(value)
  def decode(value) when is_list(value), do: Enum.map(value, &decode/1)
  def decode(%{"$dec" => text} = value) when map_size(value) == 1, do: Decimal.new(text)

  def decode(%{"$map" => [[key, value]]} = map) when map_size(map) == 1,
    do: %{key => decode(value)}

  def decode(value) when is_map(value) and map_size(value) <= 1 do
    if Enum.any?(Map.keys(value), &String.starts_with?(&1, "$")), do: invalid("unsupported tagged value")
    Map.new(value, fn {key, item} -> {key, decode(item)} end)
  end

  def decode(_), do: invalid("unsupported result value")

  defp invalid(detail), do: raise(HostError, code: "invalid value", detail: detail)
end
