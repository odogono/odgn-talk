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
  | bytes | `NorthTalk.Bytes` |
  | list | a list |
  | map | `NorthTalk.Map`; a plain map with at most one key on input |
  | quantity | `NorthTalk.Quantity` |
  | range | `NorthTalk.Range` |
  | instant | `NorthTalk.Instant`; a `DateTime` on input |
  | civil date | `NorthTalk.CivilDate`; a `Date` or `NaiveDateTime` on input |
  | pattern | `NorthTalk.Pattern` |
  | object | `NorthTalk.Object` |
  | function | `NorthTalk.Function`, only through an Instance Owner |

  Floats are refused, since they can't hold a decimal exactly, and so are
  atoms other than `nil`, `true` and `false`. Decoding never creates atoms,
  and refuses any form the encoder wouldn't write.

  `encode/1` and `decode/1` are the storage form, which has no Function
  Values. The owner converts the values it exchanges with a context, so a
  Function Value crosses as a handle bound to its Group.
  """

  alias NorthTalk.{Bytes, CivilDate, Instant, Object, Pattern, Quantity, Range}

  @max_plain 9_007_199_254_740_992

  @doc """
  Encodes `term`. Raises `NorthTalk.HostError` with code `invalid value`, or
  `wrong group` for a handle of another Group.
  """
  def encode(term, ctx \\ nil)
  def encode(nil, _), do: nil
  def encode(b, _) when is_boolean(b), do: b
  def encode(n, _) when is_integer(n) and abs(n) < @max_plain, do: n
  def encode(n, _) when is_integer(n), do: %{"$dec" => Integer.to_string(n)}

  def encode(%Decimal{} = d, ctx) do
    case number_text(d) do
      {:integer, n} -> encode(n, ctx)
      {:decimal, text} -> %{"$dec" => text}
    end
  end

  def encode(f, _) when is_float(f), do: invalid("#{f} is a float; use an integer or a Decimal")

  def encode(text, _) when is_binary(text) do
    if String.valid?(text),
      do: :unicode.characters_to_nfc_binary(text),
      else: invalid("text must be UTF-8; use NorthTalk.Bytes for bytes")
  end

  def encode(list, ctx) when is_list(list), do: Enum.map(list, &encode(&1, ctx))
  def encode(%NorthTalk.Map{entries: entries}, ctx), do: encode_map(entries, ctx)
  def encode(%Bytes{data: data}, _) when is_binary(data), do: %{"$bytes" => Base.encode64(data)}

  def encode(%Quantity{amount: amount, unit: unit}, _) when is_binary(unit) do
    text =
      case number_text(amount) do
        {:integer, n} -> Integer.to_string(n)
        {:decimal, text} -> text
      end

    %{"$quantity" => [text, unit]}
  end

  def encode(%Range{from: from, to: to}, ctx), do: %{"$range" => [encode(from, ctx), encode(to, ctx)]}
  def encode(%Instant{unix_us: us} = i, _) when is_integer(us), do: %{"$instant" => Instant.format(i)}
  def encode(%DateTime{} = dt, ctx), do: encode(Instant.from_datetime(dt), ctx)
  def encode(%CivilDate{} = c, _), do: %{"$date" => CivilDate.format(c)}
  def encode(%Date{calendar: Calendar.ISO} = d, ctx), do: encode(CivilDate.from_date(d), ctx)
  def encode(%NaiveDateTime{calendar: Calendar.ISO} = n, ctx), do: encode(CivilDate.from_naive(n), ctx)
  def encode(%Pattern{source: source}, _) when is_binary(source), do: %{"$pattern" => source}

  def encode(%Object{kind: kind, id: id, group: g}, ctx) when is_binary(kind) and is_binary(id) do
    if ctx && g && g != ctx.group, do: wrong_group("object #{kind} #{id} belongs to Group #{g}")
    %{"$object" => [kind, id]}
  end

  def encode(%NorthTalk.Function{} = f, nil),
    do: invalid("#{inspect(f)} is a Function Value, which has no storage form")

  def encode(%NorthTalk.Function{} = f, ctx) do
    if f.owner != ctx.owner or f.group != ctx.group,
      do: wrong_group("#{inspect(f)} belongs to Group #{f.group} of #{inspect(f.owner)}")

    case :ets.lookup(ctx.table, f.id) do
      [{_, _g, token}] -> %{"$function" => [f.home, f.display, token]}
      [] -> raise NorthTalk.HostError, code: "function released", detail: "#{inspect(f)} was released"
    end
  end

  def encode(map, ctx) when is_map(map) and not is_struct(map) and map_size(map) <= 1,
    do: encode_map(Map.to_list(map), ctx)

  def encode(map, _) when is_map(map) and not is_struct(map),
    do: invalid("a map with more than one key has no order; use NorthTalk.Map")

  def encode(other, _), do: invalid("#{inspect(other)} has no NorthTalk form")

  defp encode_map(entries, ctx) do
    entries = Enum.map(entries, fn {k, v} -> {key(k), encode(v, ctx)} end)

    if Enum.any?(entries, fn {k, _} -> String.starts_with?(k, "$") end),
      do: %{"$map" => Enum.map(entries, fn {k, v} -> [k, v] end)},
      else: Jason.OrderedObject.new(entries)
  end

  defp key(k) when is_binary(k), do: encode(k)
  defp key(k), do: invalid("map keys must be text, not #{inspect(k)}")

  # A number's canonical text: an integer when it has no fraction digits,
  # otherwise the Decimal's, with no exponent and an unsigned zero.
  defp number_text(n) when is_integer(n), do: {:integer, n}

  defp number_text(%Decimal{coef: coef} = d) when is_integer(coef) do
    if d.exp >= 0,
      do: {:integer, d.sign * coef * Integer.pow(10, d.exp)},
      else: {:decimal, Decimal.to_string(%{d | sign: if(coef == 0, do: 1, else: d.sign)}, :normal)}
  end

  defp number_text(%Decimal{} = d), do: invalid("#{Decimal.to_string(d)} is not a finite number")
  defp number_text(other), do: invalid("#{inspect(other)} is not a number")

  @doc """
  Decodes a value the Core sent, read with `Jason.decode(objects:
  :ordered_objects, floats: :decimals)`. A Function Value needs the owner's
  context. Raises `NorthTalk.HostError` with code `invalid value` for any
  form the encoder wouldn't write.
  """
  def decode(term, ctx \\ nil)
  def decode(nil, _), do: nil
  def decode(b, _) when is_boolean(b), do: b
  def decode(n, _) when is_integer(n) and abs(n) < @max_plain, do: n
  def decode(text, _) when is_binary(text), do: text
  def decode(list, ctx) when is_list(list), do: Enum.map(list, &decode(&1, ctx))

  def decode(%Jason.OrderedObject{values: [{"$dec", text}]}, _) when is_binary(text) do
    with {:ok, n} <- parse_number(text), true <- encode(n) == %{"$dec" => text} do
      n
    else
      _ -> invalid("#{inspect(text)} is not a canonical $dec")
    end
  end

  def decode(%Jason.OrderedObject{values: [{"$map", pairs}]}, ctx) when is_list(pairs) do
    entries =
      for pair <- pairs do
        case pair do
          [k, v] when is_binary(k) -> {k, decode(v, ctx)}
          _ -> invalid("$map holds [key, value] pairs")
        end
      end

    if Enum.any?(entries, fn {k, _} -> String.starts_with?(k, "$") end),
      do: NorthTalk.Map.new(entries),
      else: invalid("$map holds only a map with a $ key")
  end

  def decode(%Jason.OrderedObject{values: [{"$bytes", b64}]}, _) when is_binary(b64) do
    with {:ok, data} <- Base.decode64(b64), true <- Base.encode64(data) == b64 do
      Bytes.new(data)
    else
      _ -> invalid("#{inspect(b64)} is not padded standard Base64")
    end
  end

  def decode(%Jason.OrderedObject{values: [{"$quantity", [text, unit]}]}, _)
      when is_binary(text) and is_binary(unit) do
    with {:ok, n} <- parse_number(text),
         q = Quantity.new(n, unit),
         true <- encode(q) == %{"$quantity" => [text, unit]} do
      q
    else
      _ -> invalid("#{inspect(text)} is not a canonical number")
    end
  end

  def decode(%Jason.OrderedObject{values: [{"$range", [from, to]}]}, ctx),
    do: Range.new(decode(from, ctx), decode(to, ctx))

  def decode(%Jason.OrderedObject{values: [{"$instant", text}]}, _) when is_binary(text) do
    case Instant.parse(text) do
      {:ok, instant} -> instant
      :error -> invalid("#{inspect(text)} is not a canonical $instant")
    end
  end

  def decode(%Jason.OrderedObject{values: [{"$date", text}]}, _) when is_binary(text) do
    with {:ok, c} <- CivilDate.parse(text), true <- CivilDate.format(c) == text do
      c
    else
      _ -> invalid("#{inspect(text)} is not a canonical $date")
    end
  end

  def decode(%Jason.OrderedObject{values: [{"$pattern", source}]}, _) when is_binary(source),
    do: Pattern.new(source)

  def decode(%Jason.OrderedObject{values: [{"$object", [kind, id]}]}, ctx) when is_binary(kind) and is_binary(id),
    do: %Object{kind: kind, id: id, group: ctx && ctx.group}

  def decode(%Jason.OrderedObject{values: [{"$function", [home, display, token]}]}, ctx)
      when is_binary(home) and is_binary(display) and is_binary(token) do
    if ctx == nil, do: invalid("a Function Value has no storage form")
    id = make_ref()
    :ets.insert(ctx.table, {id, ctx.group, token})
    %NorthTalk.Function{owner: ctx.owner, group: ctx.group, id: id, home: home, display: display}
  end

  def decode(%Jason.OrderedObject{values: [{"$" <> _ = tag, _}]}, _),
    do: invalid("#{tag} is not a value tag, or has the wrong payload")

  def decode(%Jason.OrderedObject{values: values}, ctx) do
    if Enum.any?(values, fn {k, _} -> String.starts_with?(k, "$") end),
      do: invalid("a map with a $ key must use $map")

    NorthTalk.Map.new(for {k, v} <- values, do: {k, decode(v, ctx)})
  end

  def decode(other, _), do: invalid("#{inspect(other)} is not in the Value Encoding")

  defp parse_number(text) do
    cond do
      text =~ ~r/\A-?\d+\z/ -> {:ok, String.to_integer(text)}
      text =~ ~r/\A-?\d+\.\d+\z/ -> {:ok, Decimal.new(text)}
      true -> :error
    end
  end

  defp invalid(detail), do: raise(NorthTalk.HostError, code: "invalid value", detail: detail)
  defp wrong_group(detail), do: raise(NorthTalk.HostError, code: "wrong group", detail: detail)
end
