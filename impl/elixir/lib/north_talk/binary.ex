defmodule NorthTalk.Binary do
  @moduledoc false
  # ADR 0110's selected fields envelope (spec/embedding/request-pump-binary.md).
  # Frames convert to and from the ordered JSON the owner already reads, so
  # Values keep the Value Encoding and Function handles resolve as before.
  # Function metadata and Core-error markers are not negotiated here, so
  # their tags are refused.

  alias Jason.OrderedObject

  @feature "request-pump-fields-v1"
  @prefix <<0x4E, 0x54, 0x42, 1, 1>>
  @max 18_446_744_073_709_551_616
  @max_plain 9_007_199_254_740_992

  @messages %{
    0x01 => {"request", ~w(ref group to message)},
    0x02 => {"call", ~w(ref group fn args limits)},
    0x03 => {"pump", ~w(ref group now fuelSlice fuelCap)},
    0x04 => {"request-pump", ~w(ref group token to message now fuelSlice fuelCap)},
    0x05 => {"call-pump", ~w(ref group token fn args limits now fuelSlice fuelCap)}
  }
  @tags Map.new(@messages, fn {tag, {m, _}} -> {m, tag} end)
  @admission ~w(ref delivery err abandoned settled trace)
  @completion ~w(ref delivery token state nextDeadline fuelUsed reports gone err abandoned settled trace)
  @outer ~w(ref abandoned settled trace)

  @reports [
    {"run end",
     ~w(script run delivery broadcast handler fallback climbed outcome result error limit effect cleanupFailed at fuel alloc)},
    {"run started", ~w(script run args rootDelivery parentRun parentCall delivery selector fn)},
    {"run discarded", ~w(script run reason rootDelivery parentRun parentCall)},
    {"run accounting", ~w(script run fuel state rootDelivery parentRun parentCall)},
    {"causal work", ~w(rootDelivery liveRuns queuedMessages discardedMessages)},
    {"stop", ~w(script reason discardedRuns droppedMessages pendingCalls)},
    {"unhandled", ~w(delivery message target)},
    {"call failed", ~w(script call operation detail)},
    {"effect failure", ~w(script run grant segment phase status scope)},
    {"decided", ~w(delivery broadcast verdict vetoes undecided)},
    {"host error", ~w(code detail)},
    {"charge result", ~w(request call fuel status)}
  ]
  @report_tags @reports |> Enum.with_index(1) |> Map.new(fn {{kind, keys}, tag} -> {kind, {tag, keys}} end)
  @report_kinds @reports |> Enum.with_index(1) |> Map.new(fn {report, tag} -> {tag, report} end)

  def feature, do: @feature

  @doc "True for a binary frame, before any UTF-8 or JSON reading."
  def binary?(<<0x4E, 0x54, 0x42, _::binary>>), do: true
  def binary?(_), do: false

  @doc """
  Encodes a frame: an input with `m`, or an admission or completion reply.
  Values must already be in the Value Encoding. Raises `NorthTalk.HostError`.
  """
  def encode(frame) do
    frame = pairs(frame)
    m = get(frame, "m")

    {tag, names, data} =
      cond do
        tag = @tags[m] ->
          {tag, elem(@messages[tag], 1), List.keydelete(frame, "m", 0)}

        m != nil ->
          invalid("#{inspect(m)} has no binary form")

        true ->
          ok = get(frame, "ok")
          data = List.keydelete(frame, "ok", 0) ++ if(ok, do: pairs(ok), else: [])
          completion? = get(data, "token") != nil or get(data, "state") != nil
          if completion?, do: {0x82, @completion, data}, else: {0x81, @admission, data}
      end

    for {k, _} <- data, k not in names, do: invalid("#{k} is not a field of this frame")

    fields =
      Enum.map(names, fn
        "reports" -> reports_item(get(data, "reports"))
        name -> item(get(data, name), name, "")
      end)

    IO.iodata_to_binary([@prefix, tag, 6, uint(length(names)), fields])
  end

  @doc """
  Decodes a frame into ordered JSON shaped as its JSON form would be.
  Raises `NorthTalk.HostError` with code `invalid value` for a malformed one.
  """
  def decode(<<@prefix, tag, 6, rest::binary>>) do
    names =
      case tag do
        t when is_map_key(@messages, t) -> elem(@messages[t], 1)
        0x81 -> @admission
        0x82 -> @completion
        _ -> malformed()
      end

    {count, rest} = read_uint(rest)
    if count != length(names), do: malformed()

    {pairs, rest} =
      Enum.reduce(names, {[], rest}, fn name, {acc, rest} ->
        {value, rest} = if name == "reports", do: read_reports(rest), else: read_field(rest, name)
        {if(value == :absent, do: acc, else: [{name, value} | acc]), rest}
      end)

    if rest != "", do: malformed()
    pairs = Enum.reverse(pairs)
    if not is_integer(get(pairs, "ref")), do: malformed()
    shape(tag, pairs)
  end

  def decode(_), do: malformed()

  defp shape(tag, pairs) when tag <= 5 do
    if not is_binary(get(pairs, "group")), do: malformed()
    OrderedObject.new([{"m", elem(@messages[tag], 0)} | pairs])
  end

  defp shape(tag, pairs) do
    err = get(pairs, "err")

    cond do
      err != nil -> :ok
      tag == 0x81 and not is_binary(get(pairs, "delivery")) -> malformed()
      tag == 0x82 and not (is_binary(get(pairs, "state")) and is_integer(get(pairs, "fuelUsed"))) -> malformed()
      true -> :ok
    end

    if tag == 0x82 and is_nil(get(pairs, "delivery")) != is_nil(get(pairs, "token")), do: malformed()

    outer = if tag == 0x82, do: @outer ++ ~w(delivery token), else: @outer
    {top, inner} = Enum.split_with(pairs, fn {k, _} -> k in outer end)

    if err != nil,
      do: OrderedObject.new(top ++ [{"err", err}]),
      else: OrderedObject.new(top ++ [{"ok", OrderedObject.new(inner)}])
  end

  # ── Encoding ──

  defp reports_item(nil), do: <<0>>

  defp reports_item(reports) when is_list(reports) do
    [
      6,
      uint(length(reports)),
      Enum.map(reports, fn report ->
        report = pairs(report)
        {tag, keys} = @report_tags[get(report, "kind")] || invalid("#{inspect(get(report, "kind"))} is not a Report")
        for {k, _} <- report, k != "kind", k not in keys, do: invalid("#{k} is not a field of this Report")
        [tag, 6, uint(length(keys)), Enum.map(keys, &item(get(report, &1), &1, ""))]
      end)
    ]
  end

  defp reports_item(_), do: invalid("reports must be a list")

  # A protocol field, by the role of its key.
  defp item(nil, _key, _parent), do: <<0>>

  defp item(v, key, parent) do
    cond do
      key in ~w(fn result error object target) or (key == "reason" and parent == "vetoes") ->
        value_item(v)

      key == "args" ->
        if is_list(v), do: [6, uint(length(v)), Enum.map(v, &value_item/1)], else: invalid("args must be a list")

      is_boolean(v) ->
        if v, do: <<2>>, else: <<1>>

      is_binary(v) and key in ~w(now nextDeadline) ->
        case NorthTalk.Instant.parse(v) do
          {:ok, %{unix_us: us}} -> [11, zigzag(us)]
          :error -> invalid("#{inspect(v)} is not an instant")
        end

      is_binary(v) ->
        [0x12, text_bytes(v, false)]

      is_integer(v) ->
        integer_item(v)

      is_struct(v, Decimal) ->
        number_item(Decimal.to_string(v, :normal))

      is_list(v) ->
        [6, uint(length(v)), Enum.map(v, &item(&1, "", key))]

      true ->
        ps = pairs(v)
        [7, uint(length(ps)), Enum.map(ps, fn {k, x} -> [5, text_bytes(k, true), item(x, k, parent)] end)]
    end
  end

  # A Value in the Value Encoding.
  defp value_item(nil), do: <<0>>
  defp value_item(true), do: <<2>>
  defp value_item(false), do: <<1>>
  defp value_item(n) when is_integer(n), do: integer_item(n)
  defp value_item(s) when is_binary(s), do: [5, text_bytes(s, true)]
  defp value_item(list) when is_list(list), do: [6, uint(length(list)), Enum.map(list, &value_item/1)]

  defp value_item(v) do
    case pairs(v) do
      [{"$dec", s}] when is_binary(s) ->
        number_item(s)

      [{"$map", entries}] when is_list(entries) ->
        map_item(Enum.map(entries, fn [k, x] -> {k, x} end))

      [{"$bytes", b64}] ->
        data = Base.decode64(b64) |> elem(1)
        [8, uint(byte_size(data)), data]

      [{"$quantity", [n, unit]}] ->
        [9, number_item(n), 5, text_bytes(unit, true)]

      [{"$range", [from, to]}] ->
        [10, value_item(from), value_item(to)]

      [{"$instant", s}] ->
        item(s, "now", "")

      [{"$date", s}] ->
        [12, text_bytes(s, true)]

      [{"$pattern", s}] ->
        [13, text_bytes(s, true)]

      [{"$object", [kind, id]}] ->
        [14, 5, text_bytes(kind, true), 5, text_bytes(id, true)]

      [{"$function", [_, _, _] = xs}] ->
        [15, Enum.map(xs, &value_item/1)]

      [{"$" <> _ = tag, _}] ->
        invalid("#{tag} has no binary form here")

      entries ->
        map_item(entries)
    end
  end

  defp map_item(entries),
    do: [7, uint(length(entries)), Enum.map(entries, fn {k, x} -> [5, text_bytes(k, true), value_item(x)] end)]

  defp number_item(s) do
    if String.contains?(s, "."), do: [4, text_bytes(s, true)], else: integer_item(String.to_integer(s), s)
  end

  defp integer_item(n, s \\ nil)
  defp integer_item(n, _) when n >= 0 and n < @max, do: [3, uint(n)]
  defp integer_item(n, _) when n < 0 and n >= -@max, do: [0x10, uint(-n)]
  defp integer_item(n, s), do: [4, text_bytes(s || Integer.to_string(n), true)]

  defp text_bytes(s, nfc?) do
    if not (is_binary(s) and String.valid?(s)) or (nfc? and :unicode.characters_to_nfc_binary(s) != s),
      do: invalid("#{inspect(s)} is not NFC text")

    [uint(byte_size(s)), s]
  end

  defp zigzag(n) when n >= 0, do: uint(n * 2)
  defp zigzag(n), do: uint(-n * 2 - 1)

  defp uint(n) when n < 128, do: <<n>>
  defp uint(n), do: <<1::1, Bitwise.band(n, 127)::7, uint(Bitwise.bsr(n, 7))::binary>>

  # ── Decoding ──

  defp read_uint(bin, shift \\ 0, acc \\ 0)

  defp read_uint(<<more::1, part::7, rest::binary>>, shift, acc) when shift < 70 do
    acc = acc + Bitwise.bsl(part, shift)

    cond do
      more == 1 -> read_uint(rest, shift + 7, acc)
      shift > 0 and part == 0 -> malformed()
      acc > @max -> malformed()
      true -> {acc, rest}
    end
  end

  defp read_uint(_, _, _), do: malformed()

  defp read_count(bin) do
    {n, rest} = read_uint(bin)
    if n > byte_size(rest), do: malformed()
    {n, rest}
  end

  defp read_text(bin, nfc?) do
    {n, rest} = read_count(bin)
    <<s::binary-size(^n), rest::binary>> = rest
    if not String.valid?(s) or (nfc? and :unicode.characters_to_nfc_binary(s) != s), do: malformed()
    {s, rest}
  end

  defp read_field(<<0, rest::binary>>, _name), do: {:absent, rest}

  defp read_field(bin, name) do
    {value, rest} = read_protocol(bin, name, "")

    case name do
      "token" when not (is_integer(value) and value > 0) -> malformed()
      n when n in ~w(group delivery) and not is_binary(value) -> malformed()
      _ -> {value, rest}
    end
  end

  defp read_reports(<<0, rest::binary>>), do: {:absent, rest}

  defp read_reports(<<6, rest::binary>>) do
    {count, rest} = read_count(rest)

    {reports, rest} =
      Enum.reduce(1..count//1, {[], rest}, fn _, {acc, rest} ->
        {report, rest} = read_report(rest)
        {[report | acc], rest}
      end)

    {Enum.reverse(reports), rest}
  end

  defp read_reports(_), do: malformed()

  defp read_report(<<tag, 6, rest::binary>>) do
    {kind, keys} = @report_kinds[tag] || malformed()
    {count, rest} = read_uint(rest)
    if count != length(keys), do: malformed()

    {pairs, rest} =
      Enum.reduce(keys, {[], rest}, fn
        _, {acc, <<0, rest::binary>>} ->
          {acc, rest}

        key, {acc, rest} ->
          {v, rest} = read_protocol(rest, key, "")
          {[{key, v} | acc], rest}
      end)

    pairs = [{"kind", kind} | Enum.reverse(pairs)]

    # A completed Run whose result is Nothing still carries `result`.
    pairs =
      if kind == "run end" and get(pairs, "outcome") == "completed" and not List.keymember?(pairs, "result", 0),
        do: pairs ++ [{"result", nil}],
        else: pairs

    {OrderedObject.new(pairs), rest}
  end

  defp read_report(_), do: malformed()

  defp read_protocol(bin, key, parent) do
    cond do
      key in ~w(fn result error object target) or (key == "reason" and parent == "vetoes") ->
        read_value(bin)

      key == "args" ->
        case bin do
          <<6, rest::binary>> -> read_list(rest, &read_value/1)
          _ -> malformed()
        end

      true ->
        case bin do
          <<0, rest::binary>> ->
            {nil, rest}

          <<b, rest::binary>> when b in [1, 2] ->
            {b == 2, rest}

          <<b, _::binary>> when b in [3, 0x10] ->
            read_integer(bin)

          <<4, rest::binary>> ->
            {s, rest} = read_decimal(rest)
            {Decimal.new(s), rest}

          <<b, rest::binary>> when b in [5, 0x12] ->
            read_text(rest, b == 5)

          <<11, rest::binary>> ->
            {us, rest} = read_zigzag(rest)
            {NorthTalk.Instant.format(%NorthTalk.Instant{unix_us: us}), rest}

          <<6, rest::binary>> ->
            read_list(rest, &read_protocol(&1, "", key))

          <<7, rest::binary>> ->
            read_map(rest, &read_protocol(&1, &2, parent))

          _ ->
            malformed()
        end
    end
  end

  # A Value item, as its Value Encoding.
  defp read_value(<<0, rest::binary>>), do: {nil, rest}
  defp read_value(<<b, rest::binary>>) when b in [1, 2], do: {b == 2, rest}

  defp read_value(<<b, _::binary>> = bin) when b in [3, 0x10] do
    {n, rest} = read_integer(bin)
    {if(abs(n) < @max_plain, do: n, else: tagged("$dec", Integer.to_string(n))), rest}
  end

  defp read_value(<<4, rest::binary>>) do
    {s, rest} = read_decimal(rest)
    {tagged("$dec", s), rest}
  end

  defp read_value(<<5, rest::binary>>), do: read_text(rest, true)
  defp read_value(<<6, rest::binary>>), do: read_list(rest, &read_value/1)

  defp read_value(<<7, rest::binary>>) do
    {%OrderedObject{values: pairs}, rest} = read_map(rest, fn bin, _ -> read_value(bin) end)

    if Enum.any?(pairs, fn {k, _} -> String.starts_with?(k, "$") end),
      do: {tagged("$map", Enum.map(pairs, fn {k, v} -> [k, v] end)), rest},
      else: {OrderedObject.new(pairs), rest}
  end

  defp read_value(<<8, rest::binary>>) do
    {n, rest} = read_count(rest)
    <<data::binary-size(^n), rest::binary>> = rest
    {tagged("$bytes", Base.encode64(data)), rest}
  end

  defp read_value(<<9, rest::binary>>) do
    {n, rest} =
      case rest do
        <<4, rest::binary>> -> read_decimal(rest)
        <<b, _::binary>> when b in [3, 0x10] -> read_integer(rest) |> then(fn {n, r} -> {Integer.to_string(n), r} end)
        _ -> malformed()
      end

    case rest do
      <<5, rest::binary>> ->
        {unit, rest} = read_text(rest, true)
        {tagged("$quantity", [n, unit]), rest}

      _ ->
        malformed()
    end
  end

  defp read_value(<<10, rest::binary>>) do
    {from, rest} = read_value(rest)
    {to, rest} = read_value(rest)
    {tagged("$range", [from, to]), rest}
  end

  defp read_value(<<11, rest::binary>>) do
    {us, rest} = read_zigzag(rest)
    {tagged("$instant", NorthTalk.Instant.format(%NorthTalk.Instant{unix_us: us})), rest}
  end

  defp read_value(<<b, rest::binary>>) when b in [12, 13] do
    {s, rest} = read_text(rest, true)
    {tagged(if(b == 12, do: "$date", else: "$pattern"), s), rest}
  end

  defp read_value(<<b, rest::binary>>) when b in [14, 15] do
    {xs, rest} =
      Enum.reduce(1..if(b == 14, do: 2, else: 3), {[], rest}, fn _, {acc, rest} ->
        case rest do
          <<5, rest::binary>> ->
            {s, rest} = read_text(rest, true)
            {[s | acc], rest}

          _ ->
            malformed()
        end
      end)

    {tagged(if(b == 14, do: "$object", else: "$function"), Enum.reverse(xs)), rest}
  end

  defp read_value(_), do: malformed()

  defp read_integer(<<3, rest::binary>>) do
    {n, rest} = read_uint(rest)
    if n == @max, do: malformed()
    {n, rest}
  end

  defp read_integer(<<0x10, rest::binary>>) do
    {n, rest} = read_uint(rest)
    if n == 0, do: malformed()
    {-n, rest}
  end

  # A decimal item is only for a number no integer item holds.
  defp read_decimal(bin) do
    {s, rest} = read_text(bin, true)
    if not String.contains?(s, ".") and abs(String.to_integer(s)) < @max, do: malformed()
    {s, rest}
  rescue
    ArgumentError -> malformed()
  end

  defp read_zigzag(bin) do
    {n, rest} = read_uint(bin)
    if n >= @max, do: malformed()
    {if(rem(n, 2) == 0, do: div(n, 2), else: -div(n + 1, 2)), rest}
  end

  defp read_list(bin, read) do
    {count, rest} = read_count(bin)

    {xs, rest} =
      Enum.reduce(1..count//1, {[], rest}, fn _, {acc, rest} ->
        {x, rest} = read.(rest)
        {[x | acc], rest}
      end)

    {Enum.reverse(xs), rest}
  end

  defp read_map(bin, read) do
    {count, rest} = read_count(bin)

    {pairs, rest} =
      Enum.reduce(1..count//1, {[], rest}, fn _, {acc, rest} ->
        case rest do
          <<5, rest::binary>> ->
            {k, rest} = read_text(rest, true)
            if List.keymember?(acc, k, 0), do: malformed()
            {v, rest} = read.(rest, k)
            {[{k, v} | acc], rest}

          _ ->
            malformed()
        end
      end)

    {OrderedObject.new(Enum.reverse(pairs)), rest}
  end

  defp tagged(tag, payload), do: OrderedObject.new([{tag, payload}])

  defp pairs(%OrderedObject{values: values}), do: values
  defp pairs(map) when is_map(map) and not is_struct(map), do: Enum.sort(Map.to_list(map))
  defp pairs(other), do: invalid("#{inspect(other)} is not a record")

  defp get(pairs, key) do
    case List.keyfind(pairs, key, 0) do
      {_, v} -> v
      nil -> nil
    end
  end

  defp malformed, do: invalid("Malformed canonical binary item")
  defp invalid(detail), do: raise(NorthTalk.HostError, code: "invalid value", detail: detail)
end
