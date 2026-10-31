# `http.fetch` makes one buffered request to an origin the Grant allows

A Script can serve HTTP through the optional `http` Standard Capability ([ADR 0124](0124-http-is-an-optional-standard-capability-answered-by-the-receiving-run.md)), but it can't make a request, so every Host invents its own suspending Operation, such as the webhooks Example Host's `outbound.post`. `http` gains one suspending client Operation, `fetch url [, request]`, as ADR 0124 anticipated. It gives the whole response as a plain value, `{status, headers, body}`, and decides nothing for the Script: the body is Bytes, every status is a result, and redirects, retries, decompression and caching are left to the Script.

```talk
on showUser id
  ask http to fetch "https://api.example.com/users", {query: {id: id}} and wait
  if the status of it is not 200 then throw {code: "lookup failed", status: the status of it}
  put decodeJson(decodeText(the body of it)) into user
end showUser
```

- **The request map** mirrors `respond`'s response map: a closed map `{method, headers, query, body, json}`, every key optional. `method` defaults to `GET`. Text bodies are sent as UTF-8, Bytes as they are, and `json` by the `json` Library's rules, with `respond`'s default content types.
- **Methods** are a fixed list of uppercase words, `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE` and `OPTIONS`, as an HTTP Exchange's `method` is uppercase. Any other word raises `out of domain`.
- **`query`** has the shape of an HTTP Exchange's `query`: a map from text to text, or to a list of texts for a repeated key. The Core percent-encodes it and appends it to the URL, so a Script never encodes a URL component by hand.
- **The result** is `{status, headers, body}`. `body` is always Bytes, whatever the content type ([ADR 0003](0003-no-implicit-coercion.md)). `headers` follow the HTTP Exchange's conventions, which are normative for fetch: lowercase names, sorted, repeated values joined with `, ` in received order, and `set-cookie` a list.
- **Statuses are results.** A non-2xx response is an ordinary answer, and the Script decides which statuses it accepts. A 3xx is returned without following it. The Script reads `location` and fetches again, and the new URL is checked against the Grant.
- **The binding** decides where a Grant may connect: no destinations, an exact-origin allow-list (scheme, hostname and effective port, with no wildcards), or any origin. An embedded Host's binding allows nothing unless it says otherwise, and an empty list allows nothing. The Script Runner allows any origin, including localhost and private networks, as it allows any listening address ([ADR 0126](0126-a-northtalk-command-given-a-file-runs-it-as-a-script-runner.md)). An origin is a name, not an address: a Host that must keep Scripts off private networks checks resolved addresses as well.
- **Bounds:** the Host reads at most 8 MiB of body and 64 KiB of headers by default. The binding may change these, but a Script can't raise them. Going over either fails the call, and no partial body is returned. Script allocation limits don't bound what the Host buffers.
- **Waiting:** `fetch` declares no `maxPending`, so it waits for the Script's `MaxWait`, 30,000 ms by default, and a shorter Timeout Block wins. A timed-out, cancelled or Stopped call aborts the request as far as the Host can, but a request the server has already received may still take effect.
- **Errors:** the Core raises `invalid request`, with `field`, for a URL or header it can't accept, both `body` and `json`, a body on `GET` or `HEAD`, and a URL that has a query when `query` is also given. Unknown request keys break the closed map's Shape and raise `wrong kind`. The Host fails with `bad address` for a destination the binding refuses, `network error` for any failure to get a complete response, including DNS, connection and TLS failures, and `response too large`, with `field` (`headers` or `body`) and `limit`.

## Considered Options

- **One Operation per method** (`get`, `post`, …): shorter calls, but each one would repeat the same request map, and a Grant would limit methods rather than destinations.
- **Decoding the body by content type, or a `json` result option:** convenient, but it would be an implicit conversion. `decodeText` and `decodeJson` make it explicit, as for an HTTP Exchange's body.
- **Non-2xx statuses as Errors:** a Script would then have to catch and unpack an error to read a 404 or a 409, many of which are expected answers. Errors are kept for failing to get a response.
- **Keeping any method token as written:** HTTP method names are case-sensitive tokens, so this is more faithful to HTTP. But it differs from the inbound side, needs its own validation, and makes a JavaScript `fetch()` that uppercases `get` non-conforming. The fixed list covers ordinary APIs, and `CONNECT` and `TRACE` don't fit a buffered request.
- **Following redirects:** that is how browsers and most clients behave, but it forwards credentials and rewrites methods silently, and each hop must be checked against the Grant anyway.
- **A fixed base URL or named destinations in the binding**, as webhooks names targets: they protect a Script from naming URLs, but they make the call shape differ from Host to Host. An origin allow-list with absolute URLs keeps one call shape and still lets the Host say where Scripts may go. Named destinations can be added later.
- **Accepting any URL a browser would:** this is friendlier, but runtimes disagree on lenient parsing. The Core accepts only strict ASCII absolute HTTP(S) URLs, so every Core and Host sees the same destination. `query` covers the common case of putting Script data into a URL.
- **Transparent decompression:** this changes the bytes without changing `content-encoding`, so the result's headers would describe a different body from the one the Script gets. Fetch asks for `identity` encoding and returns what arrives unchanged.
- **A `maxPending` of its own,** as `user` has: a person may take minutes to answer, but a network call shouldn't, so the Script's `MaxWait` is enough.

## Consequences

- **Validation in the Core:** both Cores check the request and normalize its destination before calling the Host, as `locale` checks tags. The Trace, Message Layer calls and saved calls keep the Script's original arguments, as `calendar` keeps an omitted zone. The Host gets the canonical destination, enforces its binding and does the I/O. A malformed Host answer is `host error`.
- **Grants for part of `http`:** a Grant may offer only the client Operation, only the server Operations, or both, by the existing rule that a Grant may limit a Script to some of a Capability's Operations. A Host factory must support each subset.
- **Header names:** a headers map that names one header twice in different cases is invalid, for `fetch` (`invalid request`) and for `respond` (`invalid response`). Scripts can't set `host`, `content-length`, `transfer-encoding` or connection and upgrade headers, which the Host controls.
- **Trust:** HTTPS always verifies certificates and hostnames, and a Host may configure which authorities it trusts. Fetch uses no ambient cookies, credential files or response cache. A Script authenticates with headers it sets itself, and may send conditional headers and handle a 304 itself. Proxies are the Host's business.
- **Save and restore** work as for any pending call. A Host may Reissue a pending fetch on restore, accepting that the remote effect may happen twice. No save or replay guarantees exactly-once delivery. Replay answers from the Trace and makes no request.
- **Accounting:** declared call costs and result conversion charges apply as usual. Network work and Host buffering add no Fuel charge, and the bounds limit buffering instead.
- **Runtimes:** the TS (Node and Bun), Go and Elixir Hosts and the TS, Go and native Zig Script Runners offer fetch. Elixir has no `http` factory yet, and native Zig needs a new HTTPS client. A browser Host may leave fetch out. A JavaScript `fetch()` adapter still needs care for raw content coding, manual redirects and abort.
- **Chapter 7** narrows its server-only prose, including "TLS not offered", which applies to serving. It also fixes the details below this decision: the URL grammar (lowercased scheme and host, default ports, bracketed IPv6, no credentials, fragments dropped, ambiguous numeric hosts rejected), `Accept-Encoding: identity`, skipping 1xx responses, failing a 101 upgrade with `network error`, and counting trailers toward the header bound without returning them. It also fixes header byte accounting and result key order. `bad address`'s catalogue entry broadens from serving to any refused address.
- **Not in v1:** streaming, cookies kept between calls, Script control of connections, decompression, retries and caching.
