# Webhook rules Example Host

This Bun Host is the webhook rules server of [Appendix B's milestone 2](../../../../spec/appendix-b-implementation-order.md#milestone-2-the-example-hosts). It is an embedding example, built on the [chapter 9](../../../../spec/09-embedding.md) interface alone, not a product.

One Group holds one `rules` Script, driven by [`autoDrive`](../../README.md#the-group-and-trace-cases) from `@odgn/northtalk/driver` on the real Clock. Each webhook is answered through a Request to the Script. The Host shows:

- **A synchronous database as an immediate Operation:** `rules.match` reads the routing rule for an event type, and `rules.record` logs the outcome. Both are bound to a `node:sqlite` database.
- **Suspending Operations backed by Promises:** `outbound.post` uses `run`, so the Core answers the call when the `fetch` Promise resolves and fails it when the Promise rejects. Scripts name a target; only the Grant's binding holds its URL.
- **Cancellation through `AbortSignal`:** the call's `signal` aborts the `fetch` when the call is abandoned. That happens past `post`'s 2 s `maxPending`, or when the webhook client hangs up, since its `request.signal` cancels the Run.
- **Deadlines on the real Clock:** a refused or failed `post` is retried after `wait 1 s` if the rule allows, and the driver's timer pumps the Group at the deadline.

## Running it

Use Bun 1.4.2. From the repository root:

```sh
bun install
bun impl/ts/examples/webhooks/main.ts serve --port 8787
bun test impl/ts/examples/webhooks impl/ts/tests/driver.test.ts
```

`serve` keeps its database in memory unless `--database PATH` is given. It routes `order.created` to `fulfilment` with one retry, and `invoice.paid` to `accounts` with none. Both targets are a stand-in upstream on the same server, under `/sink/`, so it runs alone. The stand-in answers 202, answers 500 when the event's data has `"fail": true`, and waits 5 s first when it has `"slow": true`. With the server running:

```sh
curl -X POST localhost:8787/hooks -d '{"type": "order.created", "data": {"id": 1}}'
curl -X POST localhost:8787/hooks -d '{"type": "invoice.paid", "data": {"fail": true}}'
curl -X POST localhost:8787/hooks -d '{"type": "invoice.paid", "data": {"slow": true}}'
curl localhost:8787/events
```

| Endpoint | What it does |
| --- | --- |
| `POST /hooks` | Sends the `{type, data}` body as a Request, and replies with the Run's result as JSON: `{"status": 202, "attempts": 1}`, `{"status": "ignored"}`, or a failure code such as `"timeout"` or `"rejected"`. A Run that fails is a 422 with its `send failed` reason. |
| `GET /events` | The outcomes `rules.record` logged. |

## Its Trace Case

`record` plays a fixed scenario with a manual Clock and a stand-in `fetch` whose answers the scenario gives, and writes [`corpus/examples/webhooks/`](../../../../corpus/examples/webhooks/):

```sh
bun impl/ts/examples/webhooks/main.ts record
```

The scenario sends one event per step and settles the Group before the next step, so every Pump lands in the same place on each run. It covers:

- a Promise answering a call;
- a rejected Promise failing a call;
- a retry pumped at its deadline;
- a `maxPending` timeout whose signal aborts the fetch;
- a cancelled Request.

The answers and failures the Promises gave appear as `answer` and `fail` Host Inputs, including the late failure of an aborted fetch, which is noted `late-answer`. A live Host has no Stubs, so the recorder writes what the immediate database calls returned as `stub` lines, ahead of the inputs each Pump drained ([chapter 11](../../../../spec/11-the-trace-and-conformance.md#stubs)). The database and the URLs never appear in the case.

`webhooks.test.ts` fails if a fresh recording differs from the committed case. After changing the Host or its Script, rerecord, then bless the case with `bun run corpus:bless examples/webhooks`.

## Limits

- **One Group, one Script.** Every webhook goes to the same `rules` Script, so a slow `post` holds only its own Run, but every event shares the Script's mailbox and limits.
- **Nothing is saved.** A pending `post` or retry is lost when the process exits, even with `--database`, which keeps only rules and logged events.
- **No authentication or signature checks.** Keep the server on a loopback address.
