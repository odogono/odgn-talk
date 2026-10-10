# Multi-tenant Example Host

This Go Host is the multi-tenant server of [Appendix B's milestone 2](../../../../spec/appendix-b-implementation-order.md#milestone-2-the-example-hosts). It is an embedding example, built on the [chapter 9](../../../../spec/09-embedding.md) interface alone, not a product.

Each tenant gets its own Group holding one `shop` Script, and the [driver Pool](../../README.md#driver-pool) pumps every Group in parallel. The Host shows:

- **Grants with binding data:** one `catalog` Capability serves every tenant. Each tenant's Grant is bound to its own price list, and its `mail` Grant to its own sender address.
- **Per-Operation costs and `Charge`:** `catalog.lookUp` costs 30 Fuel and `mail.notify` 20. `notify` also Charges 50 Fuel per recipient before it sends anything, so a Run that can't cover it has a Limit Fault at the call.
- **Limits per plan:** a tenant's plan sets the limits its Script loads with. The `free` plan allows 1000 Fuel per Run and 8 mailbox messages, and the `pro` plan 50000 and 64.
- **Revocation and Reload:** revoking a tenant's `mail` Grant makes later calls raise `capability revoked`. A Reload that still calls `mail` is refused, and one that doesn't removes the Grant. A Reload carries Script Variables over.
- **Timers:** `remind` waits 10 minutes on the Group's Clock, and the Pool's timer for that Group pumps it at the deadline.
- **Billing:** `Script.Counters` gives each tenant's lifetime Fuel, Runs and Limit Faults.

## Running it

Use Go 1.27. From the repository root:

```sh
go -C impl/go run ./examples/tenants serve -addr 127.0.0.1:8080
go -C impl/go test ./examples/tenants ./driver
```

`serve` starts the two demonstration tenants: `acme` on the `pro` plan and `globex` on the `free` plan. The server reads the wall clock, and pumps with a 10000 Fuel Slice per Script so that one busy tenant can't hold a worker. With the server running:

```sh
curl -X POST localhost:8080/tenants/acme/orders -d '{"sku": "A1", "qty": 4, "to": ["ops@acme.example"]}'
curl -X POST localhost:8080/tenants/acme/reminders -d '{"to": ["ops@acme.example"], "note": "restock B2"}'
curl localhost:8080/tenants/acme/outbox
curl localhost:8080/tenants/acme/usage
curl -X POST localhost:8080/admin/tenants/globex/revoke/mail
curl -X PUT localhost:8080/admin/tenants/globex/script --data-binary @impl/go/examples/tenants/scripts/shop-quiet.talk
```

| Endpoint | What it does |
| --- | --- |
| `POST /tenants/{tenant}/orders` | Sends `order` as a Request and waits for the Run. A GBP total comes back as `{"amount", "unit"}`. A failed Run is a 422 with its `send failed` reason, and a full mailbox is a 429. |
| `POST /tenants/{tenant}/reminders` | Delivers `remind` with `to` and `note`, and returns 202 at once. |
| `GET /tenants/{tenant}/outbox` | The mail sent from the tenant's sender address. |
| `GET /tenants/{tenant}/usage` | The tenant's plan and lifetime counters. |
| `POST /admin/tenants/{tenant}/revoke/{grant}` | Queues the revocation, which lands at the Group's next Pump. |
| `PUT /admin/tenants/{tenant}/script` | Reloads the tenant's code from the body, carrying Script Variables. A refused Reload is a 422 listing its diagnostics. |

The [Scripts](scripts/) are `shop.talk`, which every tenant loads, `shop-v2.talk`, which takes 10% off ten or more of a line, and `shop-quiet.talk`, which doesn't use `mail`.

## Its Trace Cases

`record` plays a fixed scenario on both tenants with a manual Clock, and writes each tenant's Trace as a Trace Case:

```sh
go -C impl/go run ./examples/tenants record
```

It writes [`corpus/examples/tenants-acme/`](../../../../corpus/examples/tenants-acme/) and [`tenants-globex/`](../../../../corpus/examples/tenants-globex/). The scenario runs in rounds of at most one action per tenant. The two Groups pump each round in parallel, and the round ends when both have settled, so each Group's Pumps land in the same places on every run.

A live Host has no Stubs, so the recording Host notes what each Host function returned or failed with, and what it Charged. It writes those as `stub` lines ahead of the inputs that Pump drained, which is where a corpus runner writes them as it replays ([chapter 11](../../../../spec/11-the-trace-and-conformance.md#stubs)). Grant bindings never appear in a case, but the answers they produced do. `TestRecordedCasesMatchCorpus` fails if a fresh recording differs from the committed cases. After changing the Host or its Scripts, rerecord, then bless both cases with `bun run corpus:bless examples/tenants-acme examples/tenants-globex`. Their first blessings are [approved](../../../../docs/reviews/tenants-blessings/README.md), so the recorder writes no `Unblessed` marker: a changed expectation needs its own human review of the diff.

## Limits

- **State lives in memory.** Tenants, outboxes and pending reminders are lost when the process exits. The Host never saves its Groups.
- **No authentication.** Any caller can use the tenant and admin endpoints. Keep the server on a loopback address.
- **A Reload discards waiting reminders.** A successful Reload ends the Script's Runs, so a `remind` still waiting when its tenant reloads is never sent, as [chapter 10](../../../../spec/10-save-and-restore.md#reload-and-extend) requires.
- **Fixed tenants.** `serve` starts the two demonstration tenants, and there is no endpoint to add one.
