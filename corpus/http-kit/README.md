# The http test kit

Cases that every HTTP router must pass ([The HTTP router](../../spec/09-embedding.md#the-http-router), [`http`](../../spec/07-libraries-and-the-standard-library.md#http), [ADR 0124](../../docs/adr/0124-http-is-an-optional-standard-capability-answered-by-the-receiving-run.md)). The router is the Host's, so Trace Cases can't hold it to the Spec. This kit does instead, through real sockets. It is language-neutral data, so every Core's router can reuse it.

These aren't Trace Cases, and the corpus runners skip this directory.

## Format

Each `.toml` file lists `[[case]]` tables. A case has a `name`, a `script`, optional `grants`, the names it grants `http` under, `["http"]` if absent, and optional `maxBodyBytes`, the router's body limit. A runner builds a fresh router and Group, loads `script` as Script `main` with every Grant on 127.0.0.1, requests `start`, whose result is the port the requests go to, and runs `steps` in order:

| Key | Does |
| --- | --- |
| `request` | sends `"<METHOD> <target>"`, with `headers`, a map whose values are texts or lists of texts, and `body`, text; then checks the answer |
| `abort` | sends the request, then closes the connection before any answer |
| `refused` | sends the request and expects the connection to be refused |
| `send` | requests that message of the Script and waits for it and the Pumps after it |
| `sleep` | waits that many milliseconds |

A `request` checks, when present: `status`; `response`, the body as UTF-8 text; `responseHex`, the body's bytes; `excludes`, text the body mustn't contain; `type`, the `content-type`, `""` for none; and `responseHeaders`, each value joined with `, `. The bodies of the router's own 404, 413, 500 and 503 answers are the Host's.

## Running

- **TS:** [`impl/ts/tools/http-kit.ts`](../../impl/ts/tools/http-kit.ts) drives `@northtalk/ts/http`. [`impl/ts/tests/http-kit.test.ts`](../../impl/ts/tests/http-kit.test.ts) runs it under Bun, and [`impl/ts/tests/http-runtimes.test.ts`](../../impl/ts/tests/http-runtimes.test.ts) under Node.
- **Go:** [`impl/go/internal/httphost/kit_test.go`](../../impl/go/internal/httphost/kit_test.go) drives `httphost` on the driver Pool: `go -C impl/go test ./httphost`.
