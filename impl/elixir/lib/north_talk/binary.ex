defmodule NorthTalk.Binary do
  @moduledoc false
  # ADR 0110's selected fields envelope (spec/embedding/request-pump-binary.md).
  # Frames convert to and from the JSON shapes the owner already reads, so
  # Values keep the Value Encoding and Function handles resolve as before.
  # Callback needs and answers, on every crossing, skip the ordered JSON:
  # a need decodes straight to plain maps and an answer encodes from one.
  # Function metadata and Core-error markers are not negotiated here, so
  # their tags are refused.

  alias Jason.OrderedObject

  @feature "request-pump-fields-v1"
  @callbacks_feature "callbacks-fields-v1"
  @prefix <<0x4E, 0x54, 0x42, 1, 1>>
  @max 18_446_744_073_709_551_616
  @max_plain 9_007_199_254_740_992

  @prop_need 0x84

  # Each frame's fields in order, with the item each takes
  # (spec/embedding/request-pump-binary.md). A `:protocol` field holds
  # protocol items. Where nested protocol data holds Values, its kind says
  # where: `{:map, kinds}` gives the kind of each listed key, and
  # `{:list, kind}` the kind of each element.
  @target {:map, %{"object" => :value}}
  @message {:map, %{"args" => :args}}
  @base [{"ref", :protocol}, {"group", :text}]
  @notices [{"abandoned", :protocol}, {"settled", :protocol}, {"trace", :protocol}]
  @pump [{"now", :instant}, {"fuelSlice", :protocol}, {"fuelCap", :protocol}]
  @result [
    {"outcome", :protocol},
    {"value", :value},
    {"code", :protocol},
    {"message", :protocol},
    {"charged", :protocol}
  ]

  @messages %{
    0x01 => {"request", @base ++ [{"to", @target}, {"message", @message}]},
    0x02 => {"call", @base ++ [{"fn", :value}, {"args", :args}, {"limits", :protocol}]},
    0x03 => {"pump", @base ++ @pump},
    0x04 => {"request-pump", @base ++ [{"token", :token}, {"to", @target}, {"message", @message}] ++ @pump},
    0x05 =>
      {"call-pump", @base ++ [{"token", :token}, {"fn", :value}, {"args", :args}, {"limits", :protocol}] ++ @pump},
    0x06 => {"op-result", @base ++ @result},
    0x07 => {"prop-result", @base ++ @result},
    0x08 => {"effect-result", @base ++ [{"status", :protocol}]},
    0x09 => {"release-result", @base}
  }
  @needs %{
    0x83 =>
      {"op",
       [{"ref", :protocol}] ++
         Enum.map(~w(call script run segment grant capability operation mode), &{&1, :protocol}) ++
         [{"now", :instant}, {"args", :args}, {"scope", :protocol}, {"automatic", :protocol}, {"fuelLeft", :protocol}] ++
         @notices},
    @prop_need =>
      {"prop",
       [{"ref", :protocol}, {"object", :protocol}, {"prop", :protocol}, {"set", :protocol}, {"value", :value}] ++
         [{"op", :protocol}, {"selector", :value}] ++ @notices},
    0x85 =>
      {"effect",
       [{"ref", :protocol}] ++
         Enum.map(~w(script run segment grant grants coordinator phase), &{&1, :protocol}) ++
         [{"now", :instant}] ++ @notices},
    0x86 =>
      {"release",
       [{"ref", :protocol}, {"script", :protocol}, {"grant", :protocol}, {"reason", :protocol}, {"now", :instant}] ++
         @notices}
  }
  @need_tags Map.new(@needs, fn {tag, {m, _}} -> {m, tag} end)
  @tags Map.new(@messages, fn {tag, {m, _}} -> {m, tag} end)
  @admission [{"ref", :protocol}, {"delivery", :text}, {"err", :protocol}] ++ @notices
  @completion [{"ref", :protocol}, {"delivery", :text}, {"token", :token}, {"state", :protocol}] ++
                [{"nextDeadline", :instant}, {"fuelUsed", :protocol}, {"reports", :reports}, {"gone", :protocol}] ++
                [{"err", :protocol}] ++ @notices
  @schemas Map.merge(
             Map.merge(Map.new(@messages, fn {t, {_, f}} -> {t, f} end), Map.new(@needs, fn {t, {_, f}} -> {t, f} end)),
             %{0x81 => @admission, 0x82 => @completion}
           )
  @outer ~w(ref abandoned settled trace)

  # Each Report's fields in order, as for frames; unlisted kinds are protocol.
  @reports [
    {"run end",
     ~w(script run delivery broadcast handler fallback climbed outcome result error limit effect cleanupFailed at fuel alloc),
     %{"result" => :value, "error" => :value}},
    {"run started", ~w(script run args rootDelivery parentRun parentCall delivery selector fn),
     %{"args" => :args, "fn" => :value}},
    {"run discarded", ~w(script run reason rootDelivery parentRun parentCall), %{}},
    {"run accounting", ~w(script run fuel state rootDelivery parentRun parentCall), %{}},
    {"causal work", ~w(rootDelivery liveRuns queuedMessages discardedMessages), %{}},
    {"stop", ~w(script reason discardedRuns droppedMessages pendingCalls), %{}},
    {"unhandled", ~w(delivery message target), %{"message" => @message, "target" => :value}},
    {"call failed", ~w(script call operation detail), %{}},
    {"effect failure", ~w(script run grant segment phase status scope), %{}},
    {"decided", ~w(delivery broadcast verdict vetoes undecided), %{"vetoes" => {:list, {:map, %{"reason" => :value}}}}},
    {"host error", ~w(code detail), %{}},
    {"charge result", ~w(request call fuel status), %{}}
  ]
  @report_tags @reports
               |> Enum.with_index(1)
               |> Map.new(fn {{kind, keys, kinds}, tag} ->
                 {kind, {tag, Enum.map(keys, &{&1, Map.get(kinds, &1, :protocol)})}}
               end)
  @report_kinds Map.new(@report_tags, fn {kind, {tag, keys}} -> {tag, {kind, keys}} end)

  def feature, do: @feature
  def callbacks_feature, do: @callbacks_feature

  @doc "True for a binary frame, before any UTF-8 or JSON reading."
  def binary?(<<0x4E, 0x54, 0x42, _::binary>>), do: true
  def binary?(_), do: false

  @doc """
  Encodes an input/result with `m`, or an admission, completion or need reply.
  Values must already be in the Value Encoding. Raises `NorthTalk.HostError`.
  """
  def encode(frame) do
    frame = pairs(frame)
    m = get(frame, "m")

    cond do
      tag = @tags[m] ->
        fields(tag, to_wire(tag, List.keydelete(frame, "m", 0)))

      m != nil ->
        invalid("#{inspect(m)} has no binary form")

      need = get(frame, "need") ->
        need = pairs(need)
        tag = @need_tags[get(need, "m")] || invalid("need has no binary form")
        fields(tag, to_wire(tag, List.keydelete(frame, "need", 0) ++ List.keydelete(need, "m", 0)))

      true ->
        ok = get(frame, "ok")
        data = List.keydelete(frame, "ok", 0) ++ if(ok, do: pairs(ok), else: [])
        completion? = get(data, "token") != nil or get(data, "state") != nil
        fields(if(completion?, do: 0x82, else: 0x81), data)
    end
  end

  @doc """
  Encodes the owner's answer to a binary need: a result map with `m`, under
  the need's ref and Group. Raises `NorthTalk.HostError`.
  """
  def encode_answer(%{"m" => m} = answer, ref, group) do
    tag = @tags[m] || invalid("#{inspect(m)} has no binary form")
    {_, [_ref, _group | schema]} = @messages[tag]
    wire = answer_wire(tag, Map.delete(answer, "m"))
    Enum.each(wire, fn {k, _} -> List.keymember?(schema, k, 0) or invalid("#{k} is not a field of this frame") end)
    items = Enum.map(schema, fn {name, kind} -> field_item(kind, Map.get(wire, name)) end)

    IO.iodata_to_binary([
      @prefix,
      tag,
      6,
      uint(length(schema) + 2),
      field_item(:protocol, ref),
      field_item(:text, group),
      items
    ])
  end

  # An answer's fields as its binary form holds them, as `to_wire/2` gives
  # a frame's: a result's outcome becomes an explicit field.
  defp answer_wire(tag, answer) when tag in [6, 7] do
    {charged, rest} = Map.pop(answer, "charged")

    case Map.to_list(rest) do
      [{"fail", failure}] ->
        failure = Map.new(pairs(failure))

        %{
          "outcome" => "fail",
          "value" => failure["data"],
          "code" => failure["code"],
          "message" => failure["message"],
          "charged" => charged
        }

      [{outcome, value}] ->
        if outcome not in outcomes(tag), do: invalid("missing callback outcome")
        value = if outcome in ~w(result value), do: value
        %{"outcome" => outcome, "value" => value, "charged" => charged}

      _ ->
        invalid("missing callback outcome")
    end
  end

  defp answer_wire(8, answer), do: Map.delete(answer, "detail")
  defp answer_wire(_, answer), do: answer

  defp fields(tag, data) do
    schema = @schemas[tag]
    Enum.each(data, fn {k, _} -> List.keymember?(schema, k, 0) or invalid("#{k} is not a field of this frame") end)
    items = Enum.map(schema, fn {name, kind} -> field_item(kind, get(data, name)) end)
    IO.iodata_to_binary([@prefix, tag, 6, uint(length(schema)), items])
  end

  @doc """
  Decodes a frame shaped as its JSON form would be: a need as plain maps,
  ready to answer, and any other frame as ordered JSON. Raises
  `NorthTalk.HostError` with code `invalid value` for a malformed one.
  """
  def decode(<<@prefix, tag, 6, rest::binary>>) when is_map_key(@needs, tag) do
    {m, [ref | schema]} = @needs[tag]
    {ref, rest} = read_kind(read_length(rest, length(schema) + 1), elem(ref, 1))
    if not is_integer(ref), do: malformed()
    {notices, need} = notices(read_fields(rest, schema, []), [{"ref", ref}])
    Map.put(:maps.from_list(notices), "need", :maps.from_list([{"m", m} | from_wire(tag, need)]))
  end

  def decode(<<@prefix, tag, 6, rest::binary>>) when is_map_key(@schemas, tag) do
    schema = @schemas[tag]
    pairs = Enum.reverse(read_fields(read_length(rest, length(schema)), schema, []))
    if not is_integer(get(pairs, "ref")), do: malformed()
    shape(tag, pairs)
  end

  def decode(_), do: malformed()

  defp read_length(bin, n) do
    case read_uint(bin) do
      {^n, rest} -> rest
      _ -> malformed()
    end
  end

  # A need's notices come last, so they head the reversed fields.
  defp notices([{name, _} = notice | need], outer) when name in @outer, do: notices(need, [notice | outer])
  defp notices(need, outer), do: {outer, need}

  # Reads every field, dropping Nothing, into reversed pairs. Short text,
  # small integers and booleans, most of a need, are read in place, which
  # keeps the match context and allocates only the pair.
  defp read_fields(<<0, rest::binary>>, [_ | schema], acc), do: read_fields(rest, schema, acc)

  defp read_fields(<<0x12, n, s::binary-size(n), rest::binary>>, [{name, kind} | schema], acc)
       when n < 128 and kind in [:protocol, :text] do
    if not String.valid?(s), do: malformed()
    read_fields(rest, schema, [{name, s} | acc])
  end

  defp read_fields(<<3, n, rest::binary>>, [{name, kind} | schema], acc) when n < 128 and kind in [:protocol, :value],
    do: read_fields(rest, schema, [{name, n} | acc])

  defp read_fields(<<b, rest::binary>>, [{name, kind} | schema], acc) when b in [1, 2] and kind in [:protocol, :value],
    do: read_fields(rest, schema, [{name, b == 2} | acc])

  defp read_fields(bin, [{name, kind} | schema], acc) do
    {value, rest} = read_kind(bin, kind)
    read_fields(rest, schema, [{name, value} | acc])
  end

  defp read_fields(bin, [], acc) when byte_size(bin) == 0, do: acc
  defp read_fields(_, [], _), do: malformed()

  defp shape(tag, pairs) when tag in [6, 7] do
    if not is_binary(get(pairs, "group")), do: malformed()
    outcome = get(pairs, "outcome")
    if outcome not in outcomes(tag), do: malformed()

    result =
      case outcome do
        k when k in ~w(result value) ->
          get(pairs, "value")

        "fail" ->
          OrderedObject.new(
            Enum.reject(
              [{"code", get(pairs, "code")}, {"message", get(pairs, "message")}, {"data", get(pairs, "value")}],
              &is_nil(elem(&1, 1))
            )
          )

        # The other outcomes are flags: started, done, limit, ok, hostError.
        _ ->
          true
      end

    fields = Enum.filter(pairs, fn {k, _} -> k in ~w(ref group charged) end)
    OrderedObject.new([{"m", elem(@messages[tag], 0)} | fields ++ [{outcome, result}]])
  end

  defp shape(tag, pairs) when is_map_key(@messages, tag) do
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

  defp outcomes(6), do: ~w(result started done fail limit hostError)
  defp outcomes(7), do: ~w(value ok fail hostError)

  # Where a frame's JSON form carries meaning by presence, its binary form
  # has an explicit field: a result's outcome, and a property's `set`.
  defp to_wire(tag, fields) when tag in [6, 7] do
    {outcome, value} = Enum.find(fields, fn {k, _} -> k in outcomes(tag) end) || invalid("missing callback outcome")
    base = Enum.filter(fields, fn {k, _} -> k in ~w(ref group charged) end)

    data =
      case outcome do
        "fail" ->
          failure = pairs(value)
          [{"value", get(failure, "data")}, {"code", get(failure, "code")}, {"message", get(failure, "message")}]

        k when k in ~w(result value) ->
          [{"value", value}]

        _ ->
          []
      end

    base ++ [{"outcome", outcome} | data]
  end

  # Hook details stay on the Host side of the binary protocol.
  defp to_wire(8, fields), do: List.keydelete(fields, "detail", 0)
  defp to_wire(@prop_need, fields), do: [{"set", List.keymember?(fields, "value", 0)} | fields]
  defp to_wire(_, fields), do: fields

  # A setter's value stays present, even when it is Nothing.
  defp from_wire(@prop_need, fields) do
    {set, fields} = List.keytake(fields, "set", 0) || {{"set", false}, fields}

    case {set, List.keymember?(fields, "value", 0)} do
      {{_, true}, false} -> [{"value", nil} | fields]
      {{_, true}, true} -> fields
      _ -> List.keydelete(fields, "value", 0)
    end
  end

  defp from_wire(_, fields), do: fields

  defp field_item(_, nil), do: <<0>>
  defp field_item(:value, v), do: value_item(v)
  defp field_item(:args, v) when is_list(v), do: [6, uint(length(v)), Enum.map(v, &value_item/1)]
  defp field_item(:args, _), do: invalid("args must be a list")
  defp field_item({:list, kind}, v) when is_list(v), do: [6, uint(length(v)), Enum.map(v, &field_item(kind, &1))]

  defp field_item({:map, kinds}, v) when is_map(v) do
    ps = pairs(v)

    [
      7,
      uint(length(ps)),
      Enum.map(ps, fn {k, x} -> [5, text_bytes(k, true), field_item(Map.get(kinds, k, :protocol), x)] end)
    ]
  end

  defp field_item(:reports, v), do: reports_item(v)

  defp field_item(:instant, v) when is_binary(v) do
    case NorthTalk.Instant.parse(v) do
      {:ok, %{unix_us: us}} -> [11, zigzag(us)]
      :error -> invalid("#{inspect(v)} is not an instant")
    end
  end

  defp field_item(kind, v) when is_binary(v) and kind in [:protocol, :text], do: [0x12, text_bytes(v, false)]
  defp field_item(:protocol, v) when is_integer(v), do: integer_item(v)
  defp field_item(:protocol, v) when is_boolean(v), do: if(v, do: <<2>>, else: <<1>>)
  defp field_item(_, v), do: item(v)

  defp read_kind(bin, :value), do: read_value(bin)
  defp read_kind(<<6, rest::binary>>, :args), do: read_list(rest, &read_value/1)
  defp read_kind(_, :args), do: malformed()
  defp read_kind(bin, :reports), do: read_reports(bin)

  defp read_kind(bin, :text) do
    with {v, _} = read when is_binary(v) <- read_protocol(bin), do: read, else: (_ -> malformed())
  end

  defp read_kind(bin, :token) do
    with {v, _} = read when is_integer(v) and v > 0 <- read_protocol(bin), do: read, else: (_ -> malformed())
  end

  defp read_kind(<<0, rest::binary>>, _), do: {nil, rest}
  defp read_kind(<<6, rest::binary>>, {:list, kind}), do: read_list(rest, &read_kind(&1, kind))
  defp read_kind(<<7, rest::binary>>, {:map, kinds}), do: read_map(rest, &read_kind(&1, Map.get(kinds, &2, :protocol)))
  defp read_kind(_, {_, _}), do: malformed()
  defp read_kind(bin, _), do: read_protocol(bin)

  # ── Encoding ──

  defp reports_item(reports) when is_list(reports) do
    [
      6,
      uint(length(reports)),
      Enum.map(reports, fn report ->
        report = pairs(report)
        {tag, keys} = @report_tags[get(report, "kind")] || invalid("#{inspect(get(report, "kind"))} is not a Report")

        for {k, _} <- report,
            k != "kind",
            not List.keymember?(keys, k, 0),
            do: invalid("#{k} is not a field of this Report")

        [tag, 6, uint(length(keys)), Enum.map(keys, fn {key, kind} -> field_item(kind, get(report, key)) end)]
      end)
    ]
  end

  defp reports_item(_), do: invalid("reports must be a list")

  # A protocol item: protocol data with no Value positions.
  defp item(nil), do: <<0>>
  defp item(true), do: <<2>>
  defp item(false), do: <<1>>
  defp item(v) when is_binary(v), do: [0x12, text_bytes(v, false)]
  defp item(v) when is_integer(v), do: integer_item(v)
  defp item(%Decimal{} = v), do: number_item(Decimal.to_string(v, :normal))
  defp item(v) when is_list(v), do: [6, uint(length(v)), Enum.map(v, &item/1)]

  defp item(v) do
    ps = pairs(v)
    [7, uint(length(ps)), Enum.map(ps, fn {k, x} -> [5, text_bytes(k, true), item(x)] end)]
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
        field_item(:instant, s)

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

        {key, kind}, {acc, rest} ->
          {v, rest} = read_kind(rest, kind)
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

  defp read_protocol(<<0, rest::binary>>), do: {nil, rest}
  defp read_protocol(<<b, rest::binary>>) when b in [1, 2], do: {b == 2, rest}
  defp read_protocol(<<b, _::binary>> = bin) when b in [3, 0x10], do: read_integer(bin)

  defp read_protocol(<<4, rest::binary>>) do
    {s, rest} = read_decimal(rest)
    {Decimal.new(s), rest}
  end

  defp read_protocol(<<b, rest::binary>>) when b in [5, 0x12], do: read_text(rest, b == 5)

  defp read_protocol(<<11, rest::binary>>) do
    {us, rest} = read_zigzag(rest)
    {NorthTalk.Instant.format(%NorthTalk.Instant{unix_us: us}), rest}
  end

  defp read_protocol(<<6, rest::binary>>), do: read_list(rest, &read_protocol/1)
  defp read_protocol(<<7, rest::binary>>), do: read_map(rest, fn bin, _ -> read_protocol(bin) end)
  defp read_protocol(_), do: malformed()

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
