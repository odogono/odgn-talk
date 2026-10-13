# The router kit

Sequences that every notification router must follow ([Store Notifications](../../spec/11-the-trace-and-conformance.md#router-kit), [ADR 0061](../../docs/adr/0061-host-notifications-share-routing-and-are-scoped-by-grant-bindings.md)). The router is the Host's, so Trace Cases can't hold it to the Spec. This kit does instead. It is language-neutral data, so every Core's router can reuse it.

These aren't Trace Cases, and the corpus runners skip this directory.

## Format

Each `.toml` file sets default `limits`, `{watches, watchSize, pending, pendingSize}`, and default `groups`, and lists `[[sequence]]` tables. Each sequence has a `name`, optional `limits` and `groups` of its own, and `steps`. `groups` maps each stand-in Group's name to its Scripts' names, in load order.

A runner builds a fresh router, a fresh Store kept in memory and the stand-in Groups, then runs the steps in order. Every Store has the sequence's limits until a `limits` step changes them. Each stand-in Group keeps the Deliveries it accepts, and each of its Scripts' mailboxes accepts every Delivery until a `mailbox` step says otherwise.

| `do` | Does |
| --- | --- |
| `watch` | `watch` through the step's Grant, with `args`: the name, prefix and effective message, as the Core gives them to the Host |
| `unwatch` | `unwatch` through the step's Grant, with `args`: the name |
| `write` | adds `ops` to the pending writes of Segment `in`, without committing them |
| `commit` | commits Segment `in`'s pending writes, then `ops`, as one commit through the router; without `in`, a Host-originated commit of `ops` |
| `mailbox` | sets the step's Script's mailbox: `room` more Deliveries before it refuses each with `MailboxFull`, or every Delivery if `room` is absent; `gone = true` refuses each as a Script no longer in the Group does |
| `pumped` | tells the router a Pump of `group` returned |
| `release` | calls the router's release with the step's Grant and `reason` |
| `detach` | detaches `group` |
| `limits` | sets every Store's limits to `limits` |
| `checkpoint` | takes a checkpoint of `group`, kept as `as`; with `effects = true`, the Group's save refuses with `effects pending` |
| `revision` | changes `store`'s revision, as a commit made while no router watched would |
| `restore` | restores checkpoint `checkpoint` as a new Group named `as` |

Steps name their Grant, Group and Store with these keys:

| Key | Is |
| --- | --- |
| `group` | the stand-in Group; `g` if absent |
| `script` | the Script, in `group`; `a` if absent |
| `grant` | the Script's named Grant; `store` if absent. A Script's two names with one Store are aliases of it |
| `store` | the Grant's binding, the Store's name; `default` if absent |

`ops` is a display-form list of writes, applied in order: `["set", key, value]`, `["delete", key]` or `["increment", key, by]`, with chapter 7's meanings. A runner applies a commit's writes to the Store's committed contents and gives the router the keys whose values changed, compared by their Value Encoding bytes. The Store's revision changes on every commit with changed keys. A Segment's writes come from the step's Script, which only matters in reading the sequence.

A `restore` re-binds each recorded Grant to the Store it had. `grants` overrides that by `"<script>.<grant>"`: text names another Store, and `false` leaves the Grant unbound. `variablesOnly = true` makes the restore variables-only. `damage` hands the router a damaged checkpoint: `"missing"` is the bare Group save, without the routing state, and `"digest"` is routing state whose digest doesn't match its save. The restored Group has the saved Group's Scripts, and their mailboxes accept every Delivery.

Each step may state:

| Key | Is |
| --- | --- |
| `deliveries` | every Delivery the step makes, in order, each `{group, script, message, payload}`, with `group` and `script` defaulting as for steps and `payload` in the display form; none if absent |
| `error` | the error the step fails with, as a display-form map of its `code` and fields, without `message`: `watch limit` from `watch`, or a Host error from `checkpoint` or `restore` |
| `pending` | for `pumped`, whether the Group still has pending work; `false` if absent |
| `restored`, `dropped`, `resynced` | for `restore`, the watches the router lists, each `"<script>.<grant>.<watch>"`, in the order of watches; `[]` if absent |

The Core checks each call's Shapes and validates names and messages before the Host function runs, so the kit never gives a router an invalid `watch`. [Trace Cases](../capabilities/) hold the Core to those checks. A runner gives the router what a Core would: the Grant's name and binding, the calling Script and its Group.

## Running

- **TS:** [`impl/ts/tools/notify-kit.ts`](../../impl/ts/tools/notify-kit.ts) drives `@odgn/northtalk/notify` through the kit. [`impl/ts/tests/notify-kit.test.ts`](../../impl/ts/tests/notify-kit.test.ts) runs it under Bun, and under Node when it is installed.
- **Go:** [`impl/go/notify/kit_test.go`](../../impl/go/notify/kit_test.go) drives the `notify` router through the kit. `go -C impl/go test ./notify` runs it.
