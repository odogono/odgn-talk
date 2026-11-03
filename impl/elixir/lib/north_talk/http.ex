defmodule NorthTalk.HTTP do
  @moduledoc """
  The `http` Standard factory's client Operation, `fetch` (spec chapter 7,
  Fetching; chapter 9, The `http` factory; ADR 0151).

      http = NorthTalk.HTTP.capability(origins: ["https://api.example.com"], costs: %{"fetch" => 4})
      :ok = NorthTalk.define_capability!(owner, http)
      grant = NorthTalk.grant!(owner, "http")
      NorthTalk.load!(group, "s", source, grants: %{"http" => grant})

  A Host may offer `http`'s server Operations, `fetch`, or both. This Host
  offers `fetch` only. The Core checks the arguments by chapter 7's rules
  before the call is charged, and checks the answer, as for every Standard
  factory.

  `fetch` makes one buffered HTTP/1.1 request. It follows no redirect,
  retries nothing, decompresses nothing, sends no cookies and keeps no
  connection between calls. An abandoned call kills the callback's Task,
  which closes the connection.

  ## Options

    * `:origins` - the origins a Grant may fetch from: `:none` (the
      default), `:any`, a list of origins such as `"https://example.com"` or
      `"http://127.0.0.1:8080"`, or a function of the Grant's binding giving
      one of these. Any other origin fails with `bad address`.
    * `:cacerts` - the DER certificates HTTPS trusts, as `:ssl` takes them.
      Defaults to the system's, from `:public_key.cacerts_get/0`.
    * `:max_body_bytes` - the largest body read, 8,388,608 by default.
    * `:max_header_bytes` - the most header bytes read, trailers included,
      counting each field line's name and value plus 4; 65,536 by default.
    * `:costs` - each offered Operation's cost, as `%{"fetch" => cost}`, a
      cost being what `NorthTalk.Capability` takes. Required.
    * `:log` - a function of one text, told why a call failed. The Script
      only sees the failure's code.
  """

  alias NorthTalk.{Bytes, Capability, HostError}

  @max_body 8_388_608
  @max_header 65_536

  @doc "The `http` Capability offering `fetch`. Raises `NorthTalk.HostError` for bad options."
  def capability(opts \\ []) do
    costs = Keyword.get(opts, :costs, %{})
    unless Map.has_key?(costs, "fetch"), do: invalid("http needs a cost for fetch")

    config = %{
      origins: origins_option(Keyword.get(opts, :origins, :none)),
      cacerts: Keyword.get(opts, :cacerts),
      max_body: bound(opts, :max_body_bytes, @max_body),
      max_header: bound(opts, :max_header_bytes, @max_header),
      log: Keyword.get(opts, :log, fn _ -> :ok end)
    }

    request =
      closed_map([
        {"method", "text"},
        {"headers", %{"map" => [], "open" => true}},
        {"query", %{"map" => [], "open" => true}},
        {"body", %{"oneOf" => ["text", "bytes"]}},
        {"json", "any"}
      ])

    answer = %{
      "map" => [
        %{"key" => "status", "shape" => "number"},
        %{"key" => "headers", "shape" => %{"map" => [], "open" => true}},
        %{"key" => "body", "shape" => "bytes"}
      ]
    }

    # No max_pending: a fetch waits for the Script's MaxWait.
    fetch =
      [
        mode: :suspending,
        args: ["text", %{"optional" => request}],
        result: answer,
        cost: costs["fetch"],
        errors: [%{code: "bad address"}, %{code: "network error"}, %{code: "response too large"}]
      ]

    %{Capability.from_functions("http", %{"fetch" => {fetch, &fetch(config, &1, &2)}}) | standard: "http"}
  end

  @doc """
  The origins an `:origins` list allows, each as `scheme://host:port`.
  Raises `NorthTalk.HostError` for anything but exact origins.
  """
  def origins(list) when is_list(list) do
    MapSet.new(list, fn given ->
      with true <- is_binary(given),
           [_, rest] <- String.split(given, "://", parts: 2),
           false <- String.contains?(rest, ["/", "?", "#", "*", "@"]),
           {:ok, origin} <- origin(given) do
        origin
      else
        _ -> invalid("#{inspect(given)} is not an origin")
      end
    end)
  end

  def origins(other), do: invalid("#{inspect(other)} is not a list of origins")

  defp origins_option(o) when o in [:none, :any], do: o
  defp origins_option(f) when is_function(f, 1), do: f
  defp origins_option(list), do: origins(list)

  defp bound(opts, key, default) do
    case Keyword.get(opts, key, default) do
      n when is_integer(n) and n > 0 -> n
      other -> invalid("#{key} must be a positive integer, not #{inspect(other)}")
    end
  end

  defp closed_map(fields),
    do: %{"map" => Enum.map(fields, fn {k, s} -> %{"key" => k, "shape" => s, "optional" => true} end)}

  defp invalid(detail), do: raise(HostError, code: "invalid value", detail: detail)

  # The call

  @doc false
  def fetch(config, [raw | rest], call) do
    request = List.first(rest) || NorthTalk.Map.new()
    url = url(raw, request)
    origin = elem(origin(url), 1)

    if allowed?(config, call.binding, origin) do
      send_request(config, url, request)
    else
      {:error, %{code: "bad address", message: "#{origin} isn't allowed"}}
    end
  end

  defp allowed?(config, binding, origin) do
    case config.origins do
      f when is_function(f, 1) -> allowed?(%{config | origins: origins_option(f.(binding))}, binding, origin)
      :any -> true
      :none -> false
      %MapSet{} = set -> MapSet.member?(set, origin)
    end
  rescue
    e in HostError ->
      config.log.("fetch: #{e.detail}")
      false
  end

  defp send_request(config, url, request) do
    {scheme, host, port, target} = parts(url)

    case exchange(config, scheme, host, port, request_bytes(host, port, scheme, target, request)) do
      {:ok, status, headers, body} ->
        if Enum.all?(headers, fn {k, v} -> String.valid?(k) and String.valid?(v) end),
          do:
            {:ok,
             NorthTalk.Map.new([{"status", status}, {"headers", answer_headers(headers)}, {"body", %Bytes{data: body}}])},
          else: network_error(config, url, :header_not_utf8)

      {:too_large, field, limit} ->
        {:error,
         %{
           code: "response too large",
           message: "The response's #{field} pass #{limit} bytes",
           data: NorthTalk.Map.new([{"field", field}, {"limit", limit}])
         }}

      {:network_error, reason} ->
        network_error(config, url, reason)
    end
  end

  defp network_error(config, url, reason) do
    config.log.("fetch #{url}: #{inspect(reason)}")
    {:error, %{code: "network error", message: "the request failed"}}
  end

  # The URL the Core accepted, normalized, with `query` added.

  @doc false
  def url(raw, request) do
    [scheme, rest] = String.split(raw, "://", parts: 2)
    rest = rest |> String.split("#", parts: 2) |> hd()
    {authority, rest} = split_authority(rest)
    {host, port} = host_port(authority)
    scheme = String.downcase(scheme)
    port = if port in [nil, default_port(scheme)], do: "", else: ":#{port}"
    {path, query} = split_query(rest)
    path = if path == "", do: "/", else: path

    query =
      case {query, pairs(get(request, "query"))} do
        {nil, []} -> ""
        {nil, pairs} -> "?" <> Enum.join(pairs, "&")
        {q, _} -> "?" <> q
      end

    "#{scheme}://#{String.downcase(host)}#{port}#{path}#{query}"
  end

  defp split_authority(rest) do
    case :binary.match(rest, ["/", "?"]) do
      {at, _} -> String.split_at(rest, at)
      :nomatch -> {rest, ""}
    end
  end

  defp host_port("[" <> _ = authority) do
    [host, port] = String.split(authority, "]", parts: 2)
    {host <> "]", port_number(String.trim_leading(port, ":"))}
  end

  defp host_port(authority) do
    case String.split(authority, ":", parts: 2) do
      [host, port] -> {host, port_number(port)}
      [host] -> {host, nil}
    end
  end

  defp port_number(""), do: nil
  defp port_number(p), do: String.to_integer(p)

  defp split_query(rest) do
    case String.split(rest, "?", parts: 2) do
      [path, query] -> {path, query}
      [path] -> {path, nil}
    end
  end

  defp default_port("http"), do: 80
  defp default_port("https"), do: 443

  defp pairs(nil), do: []

  defp pairs(query) do
    for {k, v} <- entries(query), item <- List.wrap(v), do: encode_component(k) <> "=" <> encode_component(item)
  end

  defp encode_component(text) do
    for <<c <- text>>, into: "" do
      if c in ?A..?Z or c in ?a..?z or c in ?0..?9 or c in ~c"-._~", do: <<c>>, else: "%" <> hex(c)
    end
  end

  defp hex(c), do: c |> Integer.to_string(16) |> String.pad_leading(2, "0")

  @doc false
  def origin(url) do
    with [scheme, rest] <- String.split(url, "://", parts: 2),
         scheme = String.downcase(scheme),
         true <- scheme in ["http", "https"],
         {authority, _} = split_authority(rest |> String.split("#", parts: 2) |> hd()),
         {host, port} when host != "" <- safe_host_port(authority),
         port = port || default_port(scheme),
         true <- port in 1..65535 do
      {:ok, "#{scheme}://#{String.downcase(host)}:#{port}"}
    else
      _ -> :error
    end
  end

  defp safe_host_port(authority) do
    host_port(authority)
  rescue
    _ -> :error
  end

  defp parts(url) do
    [scheme, rest] = String.split(url, "://", parts: 2)
    {authority, target} = split_authority(rest)
    {host, port} = host_port(authority)
    {scheme, host, port || default_port(scheme), target}
  end

  # The request

  defp request_bytes(host, port, scheme, target, request) do
    method = get(request, "method") || "GET"
    given = for {k, v} <- entries(get(request, "headers")), item <- List.wrap(v), do: {k, item}
    named = MapSet.new(given, fn {k, _} -> String.downcase(k) end)

    {body, type} =
      case get(request, "body") do
        b when is_binary(b) -> {b, "text/plain; charset=utf-8"}
        %Bytes{data: b} -> {b, nil}
        nil -> if has?(request, "json"), do: {json(get(request, "json")), "application/json"}, else: {nil, nil}
      end

    authority = if port == default_port(scheme), do: host, else: "#{host}:#{port}"

    headers =
      [{"host", authority}] ++
        given ++
        if(type && not MapSet.member?(named, "content-type"), do: [{"content-type", type}], else: []) ++
        if(MapSet.member?(named, "accept-encoding"), do: [], else: [{"accept-encoding", "identity"}]) ++
        if(body || method in ~w(POST PUT PATCH), do: [{"content-length", "#{byte_size(body || "")}"}], else: []) ++
        [{"connection", "close"}]

    [method, " ", target, " HTTP/1.1\r\n", Enum.map(headers, fn {k, v} -> [k, ": ", v, "\r\n"] end), "\r\n", body || ""]
  end

  defp get(nil, _), do: nil
  defp get(%NorthTalk.Map{} = m, key), do: NorthTalk.Map.get(m, key)
  defp get(%{} = m, key), do: Map.get(m, key)

  defp has?(%NorthTalk.Map{entries: e}, key), do: List.keymember?(e, key, 0)
  defp has?(%{} = m, key), do: Map.has_key?(m, key)
  defp has?(nil, _), do: false

  defp entries(nil), do: []
  defp entries(%NorthTalk.Map{entries: e}), do: e
  defp entries(%{} = m), do: Enum.to_list(m)

  @doc false
  # The `json` Library's encoding (chapter 7, The JSON mapping). The Core
  # has refused a value it can't write.
  def json(nil), do: "null"
  def json(true), do: "true"
  def json(false), do: "false"
  def json(n) when is_integer(n), do: Integer.to_string(n)
  def json(%Decimal{} = d), do: Decimal.to_string(d, :normal)
  def json(t) when is_binary(t), do: [?", escape(t), ?"] |> IO.iodata_to_binary()
  def json(l) when is_list(l), do: "[" <> Enum.map_join(l, ",", &json/1) <> "]"

  def json(m) when is_map(m),
    do: "{" <> Enum.map_join(entries(m), ",", fn {k, v} -> json(k) <> ":" <> json(v) end) <> "}"

  defp escape(t) do
    for <<c::utf8 <- t>> do
      case c do
        ?" -> "\\\""
        ?\\ -> "\\\\"
        ?\b -> "\\b"
        ?\t -> "\\t"
        ?\n -> "\\n"
        ?\f -> "\\f"
        ?\r -> "\\r"
        c when c < 0x20 -> "\\u00" <> String.downcase(hex(c))
        c -> <<c::utf8>>
      end
    end
  end

  # The exchange

  defp exchange(config, scheme, host, port, bytes) do
    with {:ok, socket} <- connect(config, scheme, host, port),
         :ok <- write(socket, bytes) do
      try do
        response(config, socket, "", head?(bytes))
      after
        close(socket)
      end
    else
      {:error, reason} -> {:network_error, reason}
    end
  end

  defp head?([method | _]), do: method == "HEAD"

  defp connect(_config, "http", host, port),
    do: :gen_tcp.connect(address(host), port, [:binary, active: false, packet: :raw])

  defp connect(config, "https", host, port) do
    address = address(host)
    cacerts = config.cacerts || :public_key.cacerts_get()
    reference = if is_tuple(address), do: [ip: address], else: [dns_id: address]
    # A name is sent for SNI; an IP address isn't.
    sni = if is_tuple(address), do: :disable, else: address

    tls = [
      verify: :verify_peer,
      cacerts: cacerts,
      server_name_indication: sni,
      verify_fun: {&verify/3, {reference, MapSet.new(cacerts, &der/1)}},
      versions: [:"tlsv1.3", :"tlsv1.2"]
    ]

    with {:ok, tcp} <- :gen_tcp.connect(address, port, [:binary, active: false, packet: :raw]) do
      case :ssl.connect(tcp, tls) do
        {:ok, socket} -> {:ok, {:ssl, socket}}
        error -> error
      end
    end
  end

  defp der(der) when is_binary(der), do: der
  defp der({:cert, der, _}), do: der

  # The chain must end at a trusted certificate, which may be the server's
  # own, and the server's certificate must name the host: a name by its DNS
  # names, an IP address by its IP addresses.
  defp verify(cert, {:bad_cert, :selfsigned_peer} = reason, {_reference, trusted} = state) do
    if MapSet.member?(trusted, :public_key.pkix_encode(:OTPCertificate, cert, :otp)),
      do: verify(cert, :valid_peer, state),
      else: {:fail, reason}
  end

  defp verify(_cert, {:bad_cert, _} = reason, _state), do: {:fail, reason}
  defp verify(_cert, {:extension, _}, state), do: {:unknown, state}
  defp verify(_cert, :valid, state), do: {:valid, state}

  defp verify(cert, :valid_peer, {reference, _} = state) do
    if :public_key.pkix_verify_hostname(cert, reference, match_fun: :public_key.pkix_verify_hostname_match_fun(:https)),
      do: {:valid, state},
      else: {:fail, {:bad_cert, :hostname_check_failed}}
  end

  defp address("[" <> rest), do: rest |> String.trim_trailing("]") |> parse_ip()
  defp address(host), do: if(ip = parse_ip(host), do: ip, else: String.to_charlist(host))

  defp parse_ip(text) do
    case :inet.parse_strict_address(String.to_charlist(text)) do
      {:ok, ip} -> ip
      _ -> nil
    end
  end

  defp write({:ssl, s}, bytes), do: :ssl.send(s, bytes)
  defp write(s, bytes), do: :gen_tcp.send(s, bytes)

  defp recv({:ssl, s}), do: :ssl.recv(s, 0)
  defp recv(s), do: :gen_tcp.recv(s, 0)

  defp close({:ssl, s}), do: :ssl.close(s)
  defp close(s), do: :gen_tcp.close(s)

  # The response: the final one, after any informational responses.

  defp response(config, socket, buffer, head?) do
    with {:ok, line, buffer} <- line(config, socket, buffer),
         {:ok, status} <- status(line),
         {:ok, headers, buffer} <- fields(config, socket, buffer, 0) do
      cond do
        status == 101 -> {:network_error, :switching_protocols}
        status < 200 -> response(config, socket, buffer, head?)
        status > 599 -> {:network_error, {:status, status}}
        true -> body(config, socket, buffer, status, headers, head?)
      end
    end
  end

  defp status(line) do
    case Regex.run(~r/^HTTP\/1\.[01] (\d{3})(?: .*)?$/, line) do
      [_, status] -> {:ok, String.to_integer(status)}
      nil -> {:network_error, {:status_line, line}}
    end
  end

  # Field lines until an empty one, as {lowercase name, value}, bounded with
  # the header bytes already `seen`.
  defp fields(config, socket, buffer, seen, acc \\ []) do
    with {:ok, line, buffer} <- line(config, socket, buffer) do
      case line do
        "" ->
          {:ok, Enum.reverse(acc), buffer}

        _ ->
          case String.split(line, ":", parts: 2) do
            [name, value] when name != "" ->
              seen = seen + byte_size(name) + byte_size(ows(value)) + 4

              if seen > config.max_header,
                do: {:too_large, "headers", config.max_header},
                else: fields(config, socket, buffer, seen, [{String.downcase(name), ows(value)} | acc])

            _ ->
              {:network_error, {:field_line, line}}
          end
      end
    end
  end

  # A field value without the optional white space around it.
  defp ows(value), do: String.replace(value, ~r/\A[ \t]+|[ \t]+\z/, "")

  defp body(config, socket, buffer, status, headers, head?) do
    seen = Enum.reduce(headers, 0, fn {k, v}, n -> n + byte_size(k) + byte_size(v) + 4 end)
    coding = headers |> values("transfer-encoding") |> String.downcase()

    result =
      cond do
        head? or status in [204, 304] -> {:ok, ""}
        String.ends_with?(coding, "chunked") -> chunks(config, socket, buffer, seen, [], 0)
        length = values(headers, "content-length") |> nil_if_empty() -> sized(config, socket, buffer, length)
        true -> to_close(config, socket, buffer)
      end

    case result do
      {:ok, body} -> {:ok, status, headers, body}
      other -> other
    end
  end

  defp values(headers, name), do: for({^name, v} <- headers, do: v) |> Enum.join(", ")
  defp nil_if_empty(""), do: nil
  defp nil_if_empty(v), do: v

  defp sized(config, socket, buffer, length) do
    case Integer.parse(length) do
      {n, ""} when n > config.max_body ->
        {:too_large, "body", config.max_body}

      {n, ""} when n >= 0 ->
        with {:ok, body, _} <- take(socket, buffer, n), do: {:ok, body}

      _ ->
        {:network_error, {:content_length, length}}
    end
  end

  defp to_close(config, socket, buffer) do
    if byte_size(buffer) > config.max_body do
      {:too_large, "body", config.max_body}
    else
      case recv(socket) do
        {:ok, more} -> to_close(config, socket, buffer <> more)
        {:error, :closed} -> {:ok, buffer}
        {:error, reason} -> {:network_error, reason}
      end
    end
  end

  defp chunks(config, socket, buffer, seen, acc, size) do
    with {:ok, line, buffer} <- line(config, socket, buffer) do
      [hex | _] = String.split(line, ";", parts: 2)

      case Integer.parse(String.trim(hex), 16) do
        {0, ""} ->
          # Trailers count toward the header bound; the result leaves them out.
          with {:ok, _trailers, _} <- fields(config, socket, buffer, seen), do: {:ok, IO.iodata_to_binary(acc)}

        {n, ""} when size + n > config.max_body ->
          {:too_large, "body", config.max_body}

        {n, ""} when n > 0 ->
          case take(socket, buffer, n + 2) do
            {:ok, <<data::binary-size(^n), "\r\n">>, rest} -> chunks(config, socket, rest, seen, [acc, data], size + n)
            {:ok, _, _} -> {:network_error, :chunk}
            error -> error
          end

        _ ->
          {:network_error, {:chunk_size, line}}
      end
    end
  end

  # The first n bytes and the rest, reading more as needed.
  defp take(socket, buffer, n) when byte_size(buffer) < n do
    case recv(socket) do
      {:ok, more} -> take(socket, buffer <> more, n)
      {:error, reason} -> {:network_error, reason}
    end
  end

  defp take(_socket, buffer, n), do: {:ok, binary_part(buffer, 0, n), binary_part(buffer, n, byte_size(buffer) - n)}

  # One CRLF-terminated line, refusing one longer than the header bound.
  defp line(config, socket, buffer) do
    case :binary.split(buffer, "\r\n") do
      [line, rest] ->
        {:ok, line, rest}

      [_] when byte_size(buffer) > config.max_header + 2 ->
        {:too_large, "headers", config.max_header}

      [_] ->
        case recv(socket) do
          {:ok, more} -> line(config, socket, buffer <> more)
          {:error, reason} -> {:network_error, reason}
        end
    end
  end

  # Chapter 7's response headers: lowercase names in code point order,
  # repeated values joined with ", ", and set-cookie a list.
  defp answer_headers(headers) do
    headers
    |> Enum.group_by(&elem(&1, 0), &elem(&1, 1))
    |> Enum.sort_by(&elem(&1, 0))
    |> Enum.map(fn
      {"set-cookie", vs} -> {"set-cookie", vs}
      {k, vs} -> {k, Enum.join(vs, ", ")}
    end)
    |> NorthTalk.Map.new()
  end
end
