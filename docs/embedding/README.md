# The embedding interface

[`talk.go`](talk.go) and [`talk.ts`](talk.ts) are the final embedding interface for the two Cores, settled in [#72](https://github.com/odogono/odgn-talk/issues/72). They are declarations only and are never compiled. The two files have the same calls and differ only in idiom (ADR 0015). This page holds the rules they share, the Host error catalogue, the Host Manifest format and the Operation naming guide.

## The shape

- **`Core`** is process-wide. It holds the compile cache, so a Script or Library with the same code identity compiles once. It defines Capabilities and Object Kinds, compiles Libraries, and makes and restores Groups.
- **`Group`** takes every Host Input: load, add and replace Library, deliver, request, broadcast, call a Function Value, `setParent`, dispose, pump, save and settle. It also gives the Group Fingerprint. Host Objects are made per Group, since parents and disposal belong to it.
- **`Script`** is a handle for calls addressed to one Script: reload, extend, stop, cancel a Run, revoke a Grant, counters, and deliver or request to the Script itself.

## Threads and the input queue

- **Queued calls:** `Deliver`, `Request`, `Broadcast`, `Call`, `SetParent`, `Dispose`, `Stop`, `CancelRun`, `Revoke`, `Answer` and `Fail`, and cancelling a `Request` or `Call` through its context or signal. They are safe from any goroutine. Each appends to the Group's input queue, calls `OnReady` and returns at once, with a delivery id where it has one.
- **Draining:** the next Pump takes its Clock reading, then drains the queue in call order and records each input in the Trace there. A Pump never sees an input arrive halfway through.
- **Stop and cancel:** `Stop` and `CancelRun` land at the latest at the running Pump's next Host crossing (an Operation or property call) or at its end. A native Core may act on them sooner, between instructions. Scripts and replay parity can't tell the difference, since the Trace records where each one landed. Everything else waits for the next Pump.
- **Cancelling a Request:** cancelling its context or signal queues `cancel-delivery`. It cancels the Run the Delivery started. A Delivery still in the mailbox is removed instead, and reported as a `run end` with outcome `cancelled` and no run or Handler.
- **Durations:** `MaxPending` and `MaxWait` are whole milliseconds. Go refuses a finer `time.Duration`, and TS a fraction, as `invalid value`.
- **Synchronous errors:** a queued call returns an error only for facts known at the call, such as a full mailbox, a value from another Group, or a limit override that loosens. Anything else is known only when the queue is drained, and comes back as a report.
- **Worker calls:** `Load`, `Reload`, `Extend`, `AddLibrary`, `ReplaceLibrary`, `Pump`, `Save`, `Settle`, `Fingerprint` and `Counters`. They come from the one goroutine that pumps the Group. Two made at once are undefined in Go and not detected.
- **Reentry:** a worker call made from inside the Group's own Pump, from an Operation function say, is the Host error `reentrant call` in both Cores.
- **Operation functions:** these are the only Host code that runs inside a Pump, along with property `Get` and `Set`. They may make queued calls.

## Time and reports

- **The Clock is an argument:** `Pump(now, …)` takes the Group's one Clock reading, and `Call.Now()` returns it. A reading earlier than the last Pump's is `clock backwards`. A game pauses by not pumping, and freezes time by passing the same `now`.
- **Reports are returned, never called back:** a Pump returns its reports as one ordered list, and `Request` and `Call` futures settle as it finishes. Calls that end Runs outside a Pump (`Reload` and `ReplaceLibrary`) return their reports.
- **The report kinds:**
  - `run end`, carrying its delivery id and any broadcast id
  - `stop`
  - `unhandled`
  - `call failed`, which carries the Host-side detail of a `host error` the Script saw

## Function Values

- **What the Host holds:** a Function Value is an ordinary `Value` of kind `function`. The Host can read only its Home Script and its display form, and it can't build one.
- **Bound to its Group:** passing it into another Group is `wrong group`. It lives as long as the Host holds it, and nothing needs releasing.
- **Calling it:** `group.Call` has the shape of `Request`. It is a Delivery to the Home Script, recorded in the Trace as `call <display form>(args)`.
- **Staleness:** checked when the queue is drained. A stale value rejects with `send failed`, reason `function gone`, and nothing runs.
- **Taking one as an argument:** an Operation that accepts a Function Value declares the `function` Shape.
- **Not durable:** Host storage can't encode it, and a Host-held handle doesn't survive save and restore. Only the message layer carries it, as a reference form (below). A callback that must survive a save should be an ordinary message, as the `timer` Capability's are.

## The message layer

The language-neutral form of this interface, for a Host that isn't Go or TS, such as Elixir over WASI or a sidecar. [The message-layer research](../research/message-layer.md) (#73) has the full message set. These rules are fixed:

- **One message per call:** each call in `talk.go` is one JSON message with a reply. Values use the Value Encoding (ADR 0030), and declarations use the Host Manifest's data model.
- **The Host starts every exchange:** Host code that runs inside a Pump (an Operation function, a property `Get` or `Set`) comes back as an interim reply to `pump`, and the Host answers it before sending anything else to that Group. The Core never calls the Host. So a WASI build needs no reentrant imports, and a sidecar carries the same messages.
- **Received means read:** a queued call sent while a Pump runs may wait in the Host's outbox. It counts as received when the Core reads it. Its delivery id is assigned then, and `mailbox full` is decided then.
- **Charging:** each Operation call carries the Fuel the Run has left after the declared cost. `Charge` fails exactly when that can't cover it, so the Host can charge locally.
- **Abandoned calls:** the `pump` reply lists the call ids abandoned during the Pump, so a Host can cancel its own work.
- **Function Values** cross as `{"$function": [home, display, token]}`. The token holds the value's own data and its Group, so nothing needs releasing. The Core checks `wrong group` when it reads the token, and `function gone` when the queue is drained. Host storage refuses the tag.
- **Host Objects** cross as `{"$object": [kind, id]}`, read against the message's Group. The Host's own handles carry their Group, and its glue code raises `wrong group` before sending.
- **Not in parity:** framing, protocol errors and the message layer's field names, which are settled with the final spec.

## What stays out

Helpers built only on this interface, versioned with each Core and not normative:

- **Drivers:** `talk/driver` in Go (a worker pool, a run queue and a timer per Group) and `autoDrive(group)` from `@odgn/talk/driver` in TS. Game Hosts pump by hand.
- **Other helpers:** `Must*` value constructors for literals in Host code, Trace file sinks, and the corpus runner.
- **Not in v1:** decision-mode dispatch has no Host call. The language keeps ADR 0004's `veto` rule for later.
- **Left to the TS Core:** the debugger's pause hook (ADR 0028).

## Host error catalogue

Host misuse is refused at the call that made it, as a `HostError` with one of these codes. Parity covers the code, not the detail text.

| Code | Raised when |
| --- | --- |
| `clock backwards` | A Pump, or the first Pump after a restore, reads a Clock earlier than the last one |
| `parent cycle` | `setParent` would make a cycle |
| `duplicate object id` | A Host Object id is reused within its kind in one Group |
| `name reused` | extend Script reuses a name, or a Library name is added twice |
| `not quiescent` | A save is attempted during a Pump |
| `reentrant call` | A worker call is made from inside the Group's own Pump |
| `wrong group` | A Function Value or Host Object is passed into a Group it doesn't belong to |
| `library mismatch` | A Library's imports have different identities in the Group |
| `reserved name` | A Host registers a Library under a stdlib name |
| `not adoptable` | A TS `run` call is settled by adopt after a restore |
| `invalid value` | Input the value model can't hold (ADR 0030), a malformed declaration, or a limit override that loosens |

A `LoadError` carries load-time diagnostics instead, and `MailboxFull` is load shedding, not a bug.

## The Host Manifest format

- **The file:** `ExportManifest` writes one JSON file per kind of Script, named `<kind>.talk-manifest.json`. The same definitions always give the same bytes.
- **Its fields:** `kind`, `version` and `language`, then these arrays:
  - `grants`: name, Capability, and Operation Declarations
  - `libraries`: name, version, source and `needs`
  - `messages`: name, argument Shapes and receiving kinds
  - `objectKinds`: name, properties and `parentKinds`
  - `objects`: well-known name and kind
- **One data model:** Operation Declarations and Shapes use the same data model as the corpus's `case.toml`, written as JSON here and as TOML there. A Constant value inside them uses the Value Encoding.
- **Order:** declarations are ordered by name.
- **Bindings:** a Grant's binding never appears.
- **The Core never reads it**, so a stale manifest can only mislead tooling.

## Operation naming guide

A call reads `ask <capability> to <operation> <arguments>`, so the Operation's name finishes an English instruction to a noun. `ask inbox to ask` fails that test.

1. A Capability is a noun (`http`, `inbox`, `ledger`). An Operation is a verb or verb phrase that reads after `to` (`get`, `fetch`, `post`, `schedule`, `lookUp`).
2. Read the call aloud. `ask inbox to fetch unread` works, and `ask inbox to inbox` doesn't.
3. Never repeat the Capability's name in the Operation's (`tell log to log`). Use `write`, `note` or `record` instead.
4. Prefer one word. Use camelCase only when one word would be ambiguous (`lookUp`, `numberSymbols`).
5. Name an immediate Operation for its result (`lookUp`, `count`, `tag`) and a suspending one for its action (`fetch`, `charge`, `submit`).
6. An Operation name may be a keyword elsewhere (`put`, `delete`, ADR 0012) or a stdlib name. Operation names are their own namespace, so `locale`'s `upper` doesn't clash with the `upper` Built-in (ADR 0024).

`DefineCapability` refuses `ask`, `tell`, `send` and `wait` as Operation names, since they read badly on every Host. The rest of the guide is advice.

## Host conventions

Non-normative (ADR 0030): HTTP header names are lowercase. A repeated header's values are joined with `, `, except `set-cookie`, which is a list of text.
