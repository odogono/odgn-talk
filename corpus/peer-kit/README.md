# The peer kit

These are sequences that every Peer Router must follow ([The peer router](../../spec/09-embedding.md#the-peer-router), [ADR 0181](../../docs/adr/0181-the-peer-router-owns-peer-exposure-lifetime-guarded-by-peer-kit.md)). The router belongs to the Host, so Trace Cases can't hold it to the Spec, and this kit does instead. The kit is language-neutral data, so every Host's router can reuse it.

These aren't Trace Cases, and the corpus runners skip this directory.

## Format

Each `.toml` file sets the default `groups`, which maps each stand-in Group's name to its Scripts' names. It then lists `[[sequence]]` tables. Each sequence has a `name`, optional `groups` of its own, and `steps`. A router that serves one Group, as the TS `PeerRouter` does, skips the sequences with several.

A runner builds a fresh router and the stand-in Groups, attaches each, then runs the steps in order. The router has no link. Every Peer the kit uses is one the router answered `expose` with, so every Remote Send goes to this Host's own Peer Exposures, and the kit needs no transport. Each Script of a stand-in Group accepts every Delivery and Request it is given. A Request is never answered: the kit checks only that it arrived.

| `do`       | Does                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------- |
| `expose`   | `expose` through the step's Grant, with `name` or, if it has none, unnamed. `as` keeps the Peer it is answered with |
| `unexpose` | `unexpose` through the step's Grant, with `peer`, a kept Peer, or `name`                                            |
| `post`     | `post` through the step's Grant to the kept Peer `peer`, with `message` and `args`                                  |
| `call`     | `call` through the step's Grant to the kept Peer `peer`, with `message` and `args`                                  |
| `release`  | calls the router's release hook for the step's Grant, with `reason`: `stop`, `reload`, `revoke` or `disable`        |
| `detach`   | tells the router the Host discards the step's Group                                                                 |

A step names its Grant with these keys:

| Key      | Is                                                                          |
| -------- | --------------------------------------------------------------------------- |
| `group`  | the stand-in Group. `g` if absent                                           |
| `script` | the calling Script, in `group`. `a` if absent                               |
| `grant`  | the Script's named `peer` Grant. `peer` if absent. A Script has at most one |

`args` is a display-form list, `[]` if absent. Disposing a Script's owner releases its Grants with reason `stop` ([the Grant release hook](../../spec/09-embedding.md#the-grant-release-hook)), so `release` with `stop` covers owner disposal too.

Each step may state:

| Key          | Is                                                                                                                                                                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deliveries` | every Delivery or Request the step makes, in order. Each is `{group, script, kind, message, args}`: `group` and `script` default as for steps, `kind` is `deliver` for a `post` and `request` for a `call`, and `args` is in the display form. None if absent |
| `error`      | the failure the step's call ends with, as a display-form map of its `code` and fields, without `message`. Examples are `{code: "name in use"}` from `expose` and `{code: "send failed", reason: "not exposed"}` from `call`                                   |
| `same`       | for `expose`, the kept Peer it must be answered with. Without `same`, an `expose` that doesn't fail must be answered with a Peer that differs from every one kept before                                                                                      |

A `post` to a withdrawn Peer Exposure makes no Delivery and no error, because `post` never fails in the Script.

The Core checks each call's arguments before the Host function runs, so the kit never gives a router an invalid name, message or argument. [Trace Cases](../peer/) hold the Core to those checks. A runner gives the router what a Core would: the Grant's name and binding, the calling Script and its Group.

The kit doesn't cover Restore yet ([#2281](https://github.com/odogono/odgn-talk/issues/2281)).

## Running

- **TS:** [`impl/ts/tools/peer-kit.ts`](../../impl/ts/tools/peer-kit.ts) drives `@northtalk/ts/peer` through the kit, and [`impl/ts/tests/peer-kit.test.ts`](../../impl/ts/tests/peer-kit.test.ts) runs it under Bun.
- **Go:** [`impl/go/peer/kit_test.go`](../../impl/go/peer/kit_test.go) drives `northtalk.org/go/peer` through the kit. `go -C impl/go test ./peer` runs it.
