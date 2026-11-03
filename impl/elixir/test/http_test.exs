defmodule NorthTalk.HTTPTest do
  # fetch against local HTTP and TLS servers and the shared self-signed
  # fixtures in impl/ts/tests/fixtures/http-tls (chapter 7, Fetching; ADR
  # 0151), as impl/ts/tests/http-fetch-host.test.ts does for the TS Host.
  use ExUnit.Case, async: true
  alias NorthTalk.{Bytes, HostError, Result}

  @fixtures Path.expand("../../ts/tests/fixtures/http-tls", __DIR__)

  @source """
  on get url, request
    try
      ask http to fetch url, request and wait
      return it
    catch e
      return e
    end try
  end get

  on bounded url
    try
      with timeout of 200 ms
        ask http to fetch url and wait
      end timeout
      return it
    catch e
      return e
    end try
  end bounded
  """

  # Loads the Script with an http Capability made from `opts`, and runs
  # `handler` with `args` as source text.
  defp fetch(opts, handler, args, binding \\ nil) do
    owner = start_supervised!({NorthTalk, []}, id: make_ref())
    http = NorthTalk.HTTP.capability(opts |> Keyword.put_new(:costs, %{"fetch" => 1}))
    :ok = NorthTalk.define_capability!(owner, http)
    group = NorthTalk.new_group!(owner, "g", [])
    grant = NorthTalk.grant!(owner, "http", binding: binding)

    source = @source <> "\non go\n  #{handler} #{Enum.join(args, ", ")} and wait\n  return it\nend go\n"
    NorthTalk.load!(group, "s", source, grants: %{"http" => grant})
    {:ok, %Result{value: value}} = NorthTalk.request(group, "s", "go", [], 10_000)
    value
  end

  defp field(value, key), do: NorthTalk.Map.get(value, key)

  # A server on 127.0.0.1 that sends each request it reads to the test, then
  # runs `respond` with the socket and the request.
  defp listen(respond, tls \\ nil) do
    test = self()
    {:ok, listener} = :gen_tcp.listen(0, [:binary, active: false, reuseaddr: true, ip: {127, 0, 0, 1}])
    {:ok, port} = :inet.port(listener)

    start_supervised!(
      {Task,
       fn ->
         loop(listener, tls, fn socket ->
           request = read_request(socket)
           send(test, {:request, request})
           respond.(socket, request)
         end)
       end},
      id: make_ref()
    )

    "#{if tls, do: "https", else: "http"}://127.0.0.1:#{port}"
  end

  defp loop(listener, tls, serve) do
    {:ok, tcp} = :gen_tcp.accept(listener)

    socket =
      if tls do
        {:ok, s} =
          :ssl.handshake(tcp, certfile: Path.join(@fixtures, "#{tls}.crt"), keyfile: Path.join(@fixtures, "#{tls}.key"))

        {:ssl, s}
      else
        tcp
      end

    spawn(fn ->
      serve.(socket)
    end)
    |> then(&control(socket, &1))

    loop(listener, tls, serve)
  rescue
    _ -> loop(listener, tls, serve)
  catch
    _, _ -> :ok
  end

  defp control({:ssl, s}, pid), do: :ssl.controlling_process(s, pid)
  defp control(s, pid), do: :gen_tcp.controlling_process(s, pid)

  defp recv({:ssl, s}, n), do: :ssl.recv(s, n)
  defp recv(s, n), do: :gen_tcp.recv(s, n)

  defp write({:ssl, s}, data), do: :ssl.send(s, data)
  defp write(s, data), do: :gen_tcp.send(s, data)

  defp shut({:ssl, s}), do: :ssl.close(s)
  defp shut(s), do: :gen_tcp.close(s)

  defp read_request(socket, buffer \\ "") do
    case :binary.split(buffer, "\r\n\r\n") do
      [head, rest] ->
        [line | lines] = String.split(head, "\r\n")
        headers = for l <- lines, [k, v] = String.split(l, ": ", parts: 2), do: {String.downcase(k), v}
        length = headers |> List.keyfind("content-length", 0, {nil, "0"}) |> elem(1) |> String.to_integer()
        %{line: line, headers: headers, body: read_body(socket, rest, length)}

      [_] ->
        {:ok, more} = recv(socket, 0)
        read_request(socket, buffer <> more)
    end
  end

  defp read_body(_socket, body, n) when byte_size(body) >= n, do: body

  defp read_body(socket, body, n) do
    {:ok, more} = recv(socket, 0)
    read_body(socket, body <> more, n)
  end

  defp reply(status, headers, body) do
    fn socket, _ ->
      head = Enum.map(headers, fn {k, v} -> "#{k}: #{v}\r\n" end)
      write(socket, ["HTTP/1.1 #{status} X\r\ncontent-length: #{byte_size(body)}\r\n", head, "\r\n", body])
      shut(socket)
    end
  end

  test "fetch makes one request with the Script headers, identity encoding and no cookies, and returns the response as sent" do
    origin =
      listen(
        reply(
          200,
          [
            {"Content-Encoding", "gzip"},
            {"Set-Cookie", "a=1"},
            {"Set-Cookie", "b=2"},
            {"X-Repeat", "1"},
            {"X-Repeat", "2"}
          ],
          "not really gzip"
        )
      )

    result =
      fetch([origins: [origin]], "get", [
        ~s("#{origin}/users#top"),
        ~s({query: {email: "ann@example.com", tag: ["a b", "ü"]}, headers: {"X-Token": "t"}})
      ])

    assert_received {:request, request}
    assert request.line == "GET /users?email=ann%40example.com&tag=a%20b&tag=%C3%BC HTTP/1.1"
    assert {"accept-encoding", "identity"} in request.headers
    assert {"x-token", "t"} in request.headers
    refute List.keymember?(request.headers, "cookie", 0)
    refute List.keymember?(request.headers, "user-agent", 0)
    assert field(result, "status") == 200
    assert field(result, "body") == %Bytes{data: "not really gzip"}
    headers = field(result, "headers")
    assert NorthTalk.Map.keys(headers) == Enum.sort(NorthTalk.Map.keys(headers))
    assert field(headers, "set-cookie") == ["a=1", "b=2"]
    assert field(headers, "x-repeat") == "1, 2"
    assert field(headers, "content-encoding") == "gzip"
  end

  test "a body is sent with its default content type, and the Script may set its own accept-encoding" do
    origin = listen(reply(201, [], ""))

    fetch([origins: :any], "get", [
      ~s("#{origin}/"),
      ~s({method: "POST", json: {n: 1, s: "é", d: 2.50, l: [nothing, true]}})
    ])

    fetch([origins: :any], "get", [
      ~s("#{origin}/"),
      ~s({method: "PUT", body: "hé", headers: {"Accept-Encoding": "gzip"}})
    ])

    assert_received {:request, json}
    assert_received {:request, text}
    header = fn r, k -> r.headers |> List.keyfind(k, 0) |> elem(1) end

    assert {json.line, header.(json, "content-type"), header.(json, "accept-encoding"), json.body} ==
             {"POST / HTTP/1.1", "application/json", "identity", ~s({"n":1,"s":"é","d":2.50,"l":[null,true]})}

    assert {header.(text, "content-type"), header.(text, "content-length"), header.(text, "accept-encoding"), text.body} ==
             {"text/plain; charset=utf-8", "3", "gzip", "hé"}
  end

  test "a redirect, a 404 and a 500 are answers, and no redirect is followed" do
    origin =
      listen(fn socket, request ->
        case request.line do
          "GET /moved " <> _ -> reply(302, [{"location", "/elsewhere"}], "").(socket, request)
          "GET /missing " <> _ -> reply(404, [], "").(socket, request)
          _ -> reply(500, [], "").(socket, request)
        end
      end)

    moved = fetch([origins: :any], "get", [~s("#{origin}/moved"), "nothing"])
    assert field(moved, "status") == 302
    assert field(field(moved, "headers"), "location") == "/elsewhere"
    assert field(fetch([origins: :any], "get", [~s("#{origin}/missing"), "nothing"]), "status") == 404
    assert field(fetch([origins: :any], "get", [~s("#{origin}/broken"), "nothing"]), "status") == 500
    assert_received {:request, _}
    assert_received {:request, _}
    assert_received {:request, _}
    refute_received {:request, _}
  end

  test "informational responses are skipped, and chunked bodies and trailers are read" do
    origin =
      listen(fn socket, _ ->
        write(socket, [
          "HTTP/1.1 103 Early Hints\r\nlink: </a.css>; rel=preload\r\n\r\n",
          "HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\ntrailer: x-sum\r\n\r\n",
          "3\r\nfin\r\n2;ext=1\r\nal\r\n0\r\nx-sum: 5\r\n\r\n"
        ])

        shut(socket)
      end)

    r = fetch([origins: :any], "get", [~s("#{origin}/"), "nothing"])
    assert field(r, "status") == 200
    assert field(r, "body") == %Bytes{data: "final"}
    assert field(field(r, "headers"), "x-sum") == nil
  end

  test "an origin the binding does not allow is bad address, and the default allows none" do
    origin = listen(reply(200, [], ""))
    code = fn opts, binding -> fetch(opts, "get", [~s("#{origin}/"), "nothing"], binding) |> field("code") end
    assert code.([], nil) == "bad address"
    assert code.([origins: []], nil) == "bad address"
    assert code.([origins: ["https://127.0.0.1"]], nil) == "bad address"
    by_binding = [origins: fn b -> b end]
    assert code.(by_binding, ["http://example.com"]) == "bad address"
    assert code.(by_binding, [String.upcase(origin)]) == nil
    assert_received {:request, _}
    refute_received {:request, _}
  end

  test "an origin list must be exact origins" do
    assert NorthTalk.HTTP.origins(["HTTPS://Example.com:443", "http://a.test:8080", "https://[::1]"]) ==
             MapSet.new(["https://example.com:443", "http://a.test:8080", "https://[::1]:443"])

    for bad <- [
          ["https://example.com/api"],
          ["https://example.com/"],
          ["https://example.com#a"],
          ["https://*.example.com"],
          ["https://example.com?x"],
          ["ftp://example.com"],
          "all",
          [1]
        ] do
      assert_raise HostError, fn -> NorthTalk.HTTP.origins(bad) end
      assert_raise HostError, fn -> NorthTalk.HTTP.capability(origins: bad, costs: %{"fetch" => 1}) end
    end

    assert_raise HostError, fn -> NorthTalk.HTTP.capability(origins: :any) end
  end

  test "a body or headers past their bound are response too large, with no partial response" do
    origin =
      listen(fn socket, request ->
        headers =
          if String.starts_with?(request.line, "GET /headers"), do: [{"x-big", String.duplicate("x", 200)}], else: []

        reply(200, headers, String.duplicate("y", 100)).(socket, request)
      end)

    opts = [origins: :any, max_body_bytes: 99, max_header_bytes: 150]

    for {path, limit} <- [{"body", 99}, {"headers", 150}] do
      r = fetch(opts, "get", [~s("#{origin}/#{path}"), "nothing"])
      assert {field(r, "code"), field(r, "field"), field(r, "limit")} == {"response too large", path, limit}
    end

    exact = fetch([origins: :any, max_body_bytes: 100], "get", [~s("#{origin}/body"), "nothing"])
    assert field(exact, "status") == 200
  end

  test "a refused connection, a cut-off response and a switch of protocols are network errors" do
    {:ok, l} = :gen_tcp.listen(0, ip: {127, 0, 0, 1})
    {:ok, port} = :inet.port(l)
    :gen_tcp.close(l)

    cut =
      listen(fn socket, _ ->
        write(socket, "HTTP/1.1 200 OK\r\ncontent-length: 10\r\n\r\nabc")
        shut(socket)
      end)

    switching =
      listen(fn socket, _ ->
        write(socket, "HTTP/1.1 101 Switching Protocols\r\nconnection: upgrade\r\nupgrade: x\r\n\r\n")
        shut(socket)
      end)

    for url <- ["http://127.0.0.1:#{port}/", "#{cut}/", "#{switching}/"] do
      assert {url, field(fetch([origins: :any], "get", [~s("#{url}"), "nothing"]), "code")} == {url, "network error"}
    end
  end

  test "HTTPS verifies the certificate and the host name" do
    good = listen(reply(200, [], "secure"), "local")
    misnamed = listen(reply(200, [], "secure"), "other")
    cacerts = for name <- ["local", "other"], do: der(name)
    ok = fetch([origins: :any, cacerts: cacerts], "get", [~s("#{good}/"), "nothing"])
    assert field(ok, "body") == %Bytes{data: "secure"}
    untrusted = fetch([origins: :any, cacerts: []], "get", [~s("#{good}/"), "nothing"])
    assert field(untrusted, "code") == "network error"
    wrong_name = fetch([origins: :any, cacerts: cacerts], "get", [~s("#{misnamed}/"), "nothing"])
    assert field(wrong_name, "code") == "network error"
  end

  test "an abandoned call aborts its request" do
    test = self()

    origin =
      listen(fn socket, _ ->
        {:error, :closed} = recv(socket, 0)
        send(test, :aborted)
      end)

    assert field(fetch([origins: :any], "bounded", [~s("#{origin}/")]), "code") == "timeout"
    assert_receive :aborted, 5_000
  end

  test "json is written by the json Library's rules" do
    value = NorthTalk.Map.new([{"t", "q\"b\\s\b\t\n\f\r\u0001é"}, {"n", Decimal.new("-2.50")}, {"z", %{}}])
    assert NorthTalk.HTTP.json(value) == ~S({"t":"q\"b\\s\b\t\n\f\r\u0001é","n":-2.50,"z":{}})
  end

  defp der(name) do
    [{:Certificate, der, _}] = @fixtures |> Path.join("#{name}.crt") |> File.read!() |> :public_key.pem_decode()
    der
  end
end
