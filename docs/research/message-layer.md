# Message layer and suspension under `wasip1`, for an Elixir Host

Answers [#73](https://github.com/odogono/odgn-talk/issues/73), part of [#1](https://github.com/odogono/odgn-talk/issues/1). It proposes a message set that maps one-to-one onto the embedding interface settled in [#72](https://github.com/odogono/odgn-talk/issues/72) ([`talk.go`](../../spec/embedding/talk.go), [`talk.ts`](../../spec/embedding/talk.ts)). It also checks how the Go Core suspends a Run under `wasip1`, and compares WASI and a sidecar for an Elixir Host. The throwaway checks live in [`spikes/message-layer/`](../../spikes/message-layer/), and their raw output is in [`results.txt`](../../spikes/message-layer/results.txt).

## Summary

- **Suspension needs no blocking export.** `Operation.Start` returns straight away, and the Host answers later through `Call.Answer`, which is a queued Host Input ([`talk.go:289`](../../spec/embedding/talk.go), [`talk.go:323-329`](../../spec/embedding/talk.go)). So a Run on a Suspending Capability parks as plain data inside the Core (ADR 0004, 0005, 0008). The `pump` export then returns Quiescent with the pending call reported, and a later `answer` message is drained by the next `pump`. The spike ran exactly this under Go 1.27.1 `wasip1`, in both Bun and Wasmex. The Pump design already answers the issue's premise. Asyncify, JSPI and stack switching aren't needed.
- **What standard Go really can't do** under `wasip1`:
  - **Wait for the Host inside an export.** If the export's goroutine blocks and nothing else can run, the runtime exits with `fatal error: all goroutines are asleep - deadlock!` and traps. The instance is then lost.
  - **Run goroutines between exports.** Goroutines are paused until the next export call enters Go.
  - **Take a second call while an export runs.** The instance is single-threaded.

  Three talk.go rules therefore change shape across the boundary. Queued calls made during a Pump wait in a Host-side outbox. `Stop` and `CancelRun` take effect at the next crossing rather than between instructions. And `Call.Charge` becomes local arithmetic on a `fuelLeft` figure the Core sends with each call.
- **Host code inside a Pump** is limited to Operation functions and property `Get`/`Set`. It needs no blocking either. It can be a synchronous `wasmimport`, which works in Bun and Wasmex, including a reentrant export call from inside the import. Or the Core can hand it back as an interim reply to `pump` ("call this Operation, then send me its result"). The second shape keeps every exchange Host-driven, so WASI and the sidecar carry the same messages. It also needs no Core change, because the WASI adapter can run the ordinary Go Pump on a goroutine that parks across exports (checked).
- **The message set** is one JSON object per embedding call, with a reply, plus two interim Core-to-Host requests (`op` and `prop`) and one restore request (`resolve`). Values use the Value Encoding (ADR 0030). Operation Declarations and Shapes use the Host Manifest data model. Reports, abandoned call ids and Trace lines come back in the `pump` reply. Call ids, run ids and delivery ids are assigned by the Core, as now. Grant bindings, native objects, `OnReady` and futures never cross.
- **Function Values need a reference form** for the message layer, since reports, Operation arguments and `group.Call` all carry them. A by-value token, `{"$function": [home, display, token]}`, keeps "nothing needs releasing" true. The message layer accepts it, and Host storage never does.
- **Sidecar versus WASI.** The two are measured here on one M1 Pro:
  - **Per crossing:** a native Go sidecar on an Erlang Port with `{packet, 4}` costs **7–10 µs per frame round trip**. In Wasmex, a bare export call costs **17–29 µs**, and a JSON frame in and out through linear memory costs **81–358 µs**.
  - **Core speed:** the sidecar runs the Core at native speed, where `wasip1` is 3.5–7× slower ([go-wasm spike](go-wasm-spike.md)).
  - **Crashes:** each keeps the BEAM alive when the Core dies. A trap in Wasmex comes back as `{:error, …}`, and a killed sidecar comes back as an `exit_status`.
  - **What WASI buys:** one portable `.wasm`, no native binary per target, and a hard memory cap per instance.
  - **What the sidecar buys:** parallel Groups, since Wasm runs one thread per instance.
- **One message layer serves both.** The messages, ids and encodings are the same. Only the framing differs: linear memory plus exports under WASI, or length-prefixed frames on stdio for the sidecar. Under WASI there is also a rule that inputs sent during a Pump wait in the Host's outbox.

## Setup

| | |
|---|---|
| Machine | Apple M1 Pro, 32 GiB, macOS 26.7 |
| Go | 1.27.1, `GOOS=wasip1 GOARCH=wasm -buildmode=c-shared` (a WASI reactor), and native for the sidecar |
| Wasm hosts | Bun 1.4.2 with the [go-wasm spike's WASI shim](../../spikes/go-wasm/host/wasi.js); Wasmex 0.15.1 (Wasmtime 47.0.2) on Elixir 1.20.4, OTP 29 |
| Wasmex source read | [`tessi/wasmex@d473cd2`](https://github.com/tessi/wasmex/tree/d473cd24bce21f35045e8a094c8fb1bbf796f89b) |

[`main.go`](../../spikes/message-layer/main.go) is one reactor with an export for each check. [`host.js`](../../spikes/message-layer/host.js) and the `.exs` scripts drive it. The sidecar stand-in, [`sidecar/main.go`](../../spikes/message-layer/sidecar/main.go), only echoes frames, so it measures the transport and not a Core. Latency figures are means over 5,000–20,000 calls after a warm-up. They varied between runs by up to 2×, and one Wasmex run of export-plus-import averaged 1.3 ms, so read them as orders of magnitude.

## Suspension under `wasip1`

### What standard Go does with an export that blocks

- **The accepted proposal** ([golang/go#65199](https://github.com/golang/go/issues/65199)) says: "When the goroutine running the exported function blocks for any reason, the function will yield to the Go runtime. The Go runtime will schedule other goroutines as necessary. If there are no other goroutines, the application will crash with a deadlock, as there is no way to proceed, and Wasm code cannot block."
- **Goroutines between exports:** the same proposal says "all goroutines still running when the invocation of the `go:wasmexport` function returns will be paused until the control flow re-enters the Go application".
- **Where this lives in the runtime:**
  - Under `wasip1`, `beforeIdle` does nothing ([`runtime/lock_wasip1.go:110`](https://github.com/golang/go/blob/go1.27.1/src/runtime/lock_wasip1.go#L110)), so an idle scheduler reaches `checkdead` and `fatal("all goroutines are asleep - deadlock!")` ([`runtime/proc.go:6519`](https://github.com/golang/go/blob/go1.27.1/src/runtime/proc.go#L6519)).
  - The export wrapper runs `wasm_pc_f_loop_export`, which lets other goroutines run while the export's goroutine is parked, and returns to the Wasm host only when the export itself returns ([`cmd/internal/obj/wasm/wasmobj.go:903-990`](https://github.com/golang/go/blob/go1.27.1/src/cmd/internal/obj/wasm/wasmobj.go#L903), [`runtime/asm_wasm.s:541`](https://github.com/golang/go/blob/go1.27.1/src/runtime/asm_wasm.s#L541)).
  - In a `c-shared` build, `main` is never run. The runtime `pause`s back to the host after `_initialize` and keeps its one M and G for later calls ([`runtime/proc.go:285-296`](https://github.com/golang/go/blob/go1.27.1/src/runtime/proc.go#L285)). `c-shared` "on wasip1 … builds it to a WASI reactor/library" ([`cmd/go` docs](https://pkg.go.dev/cmd/go#hdr-Build_modes)). The [Go 1.24 release notes](https://go.dev/doc/go1.24) added both `go:wasmexport` and this build mode.
  - A goroutine sleeping on a timer, with nothing else runnable, reaches `netpoll`, which calls WASI `poll_oneoff` and blocks the host thread until the timer fires ([`runtime/netpoll_wasip1.go:187-212`](https://github.com/golang/go/blob/go1.27.1/src/runtime/netpoll_wasip1.go#L187)). So a Core that slept would stall the Host's thread, not suspend.

What the spike saw, identically in Bun and in Wasmex:

| Check | Result |
|---|---|
| An export blocks on a channel with no sender | `fatal error: all goroutines are asleep - deadlock!`, then a trap (`unreachable`). Wasmex returns `{:error, "… wasm trap …"}`, and its GenServer stays alive. |
| A goroutine started by one export | It made 0 progress across later exports that didn't yield. It ran only while an export called `runtime.Gosched()`. |
| An export calls a `wasmimport` (an immediate Operation) | It works, and the import runs synchronously. In Wasmex it runs in the instance's GenServer process. |
| An export called again from inside an import (reentry) | It works in Bun directly, and in Wasmex through the callback's `caller`. |
| A goroutine per Run, parked on a channel across exports, and answered by a later export | It works, because the export's own goroutine never blocks. |
| A plain-data Run: `pump` parks it and reports call 1, `answer(1, 37)` queues, and the next `pump` completes | It works, and it is the design proposed here. |
| A Wasmex call timeout (200 ms) on a spinning export | The caller exits with `:timeout`. Wasmex interrupts the Wasm, which unwinds the Go runtime mid-export. The instance still answered later calls, but the go-wasm spike showed such instances decay, so it counts as lost. |

### Why the Pump never needs a blocking export

The interface was built so that no Core call waits for the Host:

- **The Core owns no threads or timers.** A Pump runs until nothing is runnable, then returns Quiescent (ADR 0015, [`talk.go:620-626`](../../spec/embedding/talk.go)).
- **A suspending Operation is started, not awaited.** `Start func(c *Call, args []Value) error` returns at once, and the Host answers later through `c` ([`talk.go:289`](../../spec/embedding/talk.go)). TS's Promise-returning `run` is sugar over `start`/`answer` on the Host side ([`talk.ts:178-188`](../../spec/embedding/talk.ts)).
- **Answers are inputs.** `Answer`, `AnswerWithCost` and `Fail` append to the input queue, and the next Pump drains them ([`talk.go:323-329`](../../spec/embedding/talk.go), [README](../../spec/09-embedding.md#threads-and-the-input-queue)).
- **Runs are already plain data.** Heap frames and a run loop that can return (ADR 0004), plain-data Run state (ADR 0005, ADR 0008), and preemption only between instructions (ADR 0010) are what save-anywhere already needs. A Join's several pending calls are just several entries in that data (ADR 0026).
- **Futures are Host-side.** `Pending.Done()` is the only blocking thing in talk.go ([`talk.go:612`](../../spec/embedding/talk.go)), and it settles from a `run end` report. A binding builds it from the reports, so it never crosses.

So a Run that calls `fetch` goes through this sequence. The `pump` export runs until it reaches the call. The Core charges the declared cost, assigns `pricing/r1.c1`, and calls `Start` (as `op`, below). `Start` returns, the Run parks as data, and the Pump carries on with other Runs until the Group is Quiescent. `pump` then returns. Later the Host sends `answer pricing/r1.c1`, and the next `pump` drains it and resumes the Run. Nothing waits inside Wasm. The go-wasm spike's open question ("whether a Go core can suspend a Run across a Host promise without keeping all interpreter state explicit") is moot, because ADRs 0004, 0005 and 0008 require the state to be explicit anyway.

### Host code that runs inside a Pump

Every Go callback that talk.go runs during a Pump, and what it becomes across the boundary:

| talk.go | During a Pump? | Across the boundary |
|---|---|---|
| `Operation.Do` (immediate) | yes | `op` request. Its reply is a result, a Script error, `limit`, or a `host error` detail. |
| `Operation.Start` (suspending) | yes | `op` request. Its reply is `started`, and the answer comes later as an `answer` message. |
| `Operation.Fire` (fire-and-forget) | yes | `op` request. Its reply is `done`, and the result is dropped. |
| `Prop.Get` / `Prop.Set` | yes | `prop` request |
| `Call.ID`, `ScriptName`, `Now`, `Binding` | read inside the above | Fields of `op`: `call`, `script`, `now`, and the `grant` handle. The Host looks up the binding by handle. |
| `Call.Charge` | only while starting | Local to the Host. `op` carries `fuelLeft` after the declared cost. The Host's `charge` subtracts from it and fails when it would go below zero, and the reply carries the total `charged`. This needs no reentrant crossing. |
| `Call.Context` (abandoned) | cancelled during a Pump | The `pump` reply lists `abandoned` call ids, and the Host cancels its own context. |
| `Call.Answer`/`Fail` made from inside `Start`, or `Deliver` from inside `Do` | yes (queued calls) | They go into the Host's outbox and are sent after the `pump` reply. This is equivalent, because a queued call made during a Pump is drained only at the next Pump anyway. |
| `GroupOptions.OnReady` | from any goroutine | Stays Host-side. Every queued input comes from the Host, so the binding knows when it sends one. `nextDeadline` in the `pump` reply covers time. |
| `TraceSink.Record` | yes | Trace lines ride in the `pump` reply (and in the replies to `load`, `reload` and the like). |
| `RestoreOptions.Grants` / `Resolve` | during `Restore` | One `resolve` request listing every (Script, grant name) and (kind, id) the save needs. |

### What can't be done synchronously across the boundary

- **Any wait on the Host inside an export.** It deadlocks and traps. So the adapter never makes an export's own goroutine wait on a channel that only the Host can fill.
- **Concurrent entry.** An instance runs one export at a time, and Wasmex queues every call to a Store through one executor task ([`store_executor.rs:28-33`](https://github.com/tessi/wasmex/blob/d473cd24bce21f35045e8a094c8fb1bbf796f89b/native/wasmex/src/store_executor.rs#L28)). So "safe from any goroutine" becomes "held in the binding's outbox until the instance is free". Groups in one instance pump one after another, never in parallel.
- **`Stop` and `CancelRun` between instructions.** A `wasip1` Pump can't see a Host message until it crosses. They land at the next `op`/`prop` exchange or at the Pump's end, so a Host that needs prompt stops pumps with a Fuel Slice. Where a stop lands already depends on timing and is recorded in the Trace, so replay parity is unaffected. Only the latency changes.
- **Background work in the Core.** Goroutines don't run between exports, and a sleeping Core blocks the host thread in `poll_oneoff`. Neither is needed: time comes in `pump`.
- **Host-side interrupts.** A Wasmex call timeout interrupts the Wasm ([`lib/wasmex.ex:399-419`](https://github.com/tessi/wasmex/blob/d473cd24bce21f35045e8a094c8fb1bbf796f89b/lib/wasmex.ex#L399)), which unwinds the Go runtime as a trap does. A binding must call Core exports with `:infinity` and bound work through Fuel Slices. Wasmex's always-on epoch deadline only *yields*, which is harmless ([`store_executor.rs:47-57`](https://github.com/tessi/wasmex/blob/d473cd24bce21f35045e8a094c8fb1bbf796f89b/native/wasmex/src/store_executor.rs#L47)).

### Two ways to call the Host mid-Pump

1. **Imports:** `op` is a synchronous `wasmimport`. This is simple, and it works in both hosts. In Wasmex each import becomes an `{:invoke_callback, …}` message to the instance's GenServer, whose Elixir function runs there. The Wasm side then awaits a oneshot reply ([`environment.rs:101-107`](https://github.com/tessi/wasmex/blob/d473cd24bce21f35045e8a094c8fb1bbf796f89b/native/wasmex/src/environment.rs#L101), [`lib/wasmex.ex:542-580`](https://github.com/tessi/wasmex/blob/d473cd24bce21f35045e8a094c8fb1bbf796f89b/lib/wasmex.ex#L542)). One import added ~17–20 µs to an export call. Reading the frame from inside the callback costs further hops through `caller`. The callback also mustn't call its own GenServer, or it deadlocks ([`lib/wasmex/instance.ex:47`](https://github.com/tessi/wasmex/blob/d473cd24bce21f35045e8a094c8fb1bbf796f89b/lib/wasmex/instance.ex#L47)).
2. **Return and resume:** `pump` returns an interim reply (`op`), and the Host sends `op-result` through the same export. The WASI adapter gets this with no Core change: it runs the ordinary Go `Group.Pump` on a goroutine, and the adapter's `Do`/`Start` stubs park that goroutine on a channel, while the export goroutine returns the interim reply. The spike's goroutine-per-Run check is that mechanism. It costs one export round trip per Host call, about the same as an import, but the Core never calls the Host. The sidecar exchange then has exactly the same shape.

**Recommendation:** the second. It makes the message layer strictly request and reply from the Host on both transports. It keeps Elixir Operation functions out of Wasmex's callback context, and it needs no reentrancy.

### Rejected alternatives

- **Asyncify** (Binaryen's unwind/rewind transform, [`Asyncify.cpp`](https://github.com/WebAssembly/binaryen/blob/main/src/passes/Asyncify.cpp)): it would let an export block on the Host. It costs size and speed, it is only available to standard Go by post-processing, and TinyGo's `-scheduler=asyncify` ([TinyGo options](https://tinygo.org/docs/reference/usage/important-options/)) is ruled out by ADR 0009. It isn't needed.
- **JSPI** is standardised (phase 5, [WebAssembly/proposals](https://github.com/WebAssembly/proposals)), but it is a JS-embedding feature, and Wasmtime isn't JS.
- **Stack switching** is phase 3 ([proposals](https://github.com/WebAssembly/proposals)). Wasmtime's support is tier 3, x86_64 Linux only, and off by default ([Wasmtime proposal status](https://docs.wasmtime.dev/stability-wasm-proposals.html)). Go doesn't target it.
- **A goroutine per Run:** it works across exports (checked), but it binds Run state to goroutine stacks, which ADR 0005 and ADR 0008 forbid.

## The message set

### Framing and conventions

- **One message is one JSON object in UTF-8:** `{"m": "<name>", "ref": <n>, …fields}`. `ref` is a Host-chosen integer that the reply echoes, and it never enters the Trace.
- **Replies:** `{"ref": n, "ok": {…}}`, or `{"ref": n, "err": {…}}`. The error forms are:
  - `{"kind": "host error", "code": <Host error catalogue code>, "detail": …}`
  - `{"kind": "load error", "diagnostics": [{code, message, unit, line, col}]}`
  - `{"kind": "mailbox full"}`
- **Interim replies:** a reply to `pump` or `restore` may instead be `{"ref": n, "need": {…}}` (`op`, `prop` or `resolve`). The Host must answer with the matching `*-result` message, under the same `ref`, before anything else for that Group. Any worker message sent then is `reentrant call`.
- **Payloads:**
  - Every Script value, marked (V) in the table, is in the Value Encoding (ADR 0030).
  - Operation Declarations, Shapes and `ErrorDecl`s use the Host Manifest's data model ([README](../../spec/09-embedding.md#the-host-manifest-format)).
  - `now` and `nextDeadline` use the `$instant` text form.
  - Byte blobs (saves, identities, fingerprints) are `{"$bytes": …}`.
  - Other integers are plain JSON integers, and must stay below 2⁵³.
  - A `ScriptError` is `{code, message, data (V)}`.
- **Transports:**
  - **WASI:** two exports. `talk_buffer(n) → ptr` gives the Host a buffer to write a frame into, and `talk_send(n) → u64` returns the reply frame's pointer and length packed as `ptr<<32 | len` (checked in the spike). No imports are needed beyond WASI's own.
  - **Sidecar:** a 4-byte big-endian length, then the same JSON, both ways on stdio. That is Erlang's `{packet, 4}` port option ([ports guide](https://www.erlang.org/doc/system/c_port.html), [`open_port/2`](https://www.erlang.org/doc/apps/erts/erlang.html#open_port/2)).

### Messages

H→C is a Host message with a reply, and C→H is an interim request inside a `pump` or `restore`. Every Group message carries `group`, and every Script message also carries `script`.

| Message | Dir | Fields | Reply | talk.go / talk.ts |
|---|---|---|---|---|
| `hello` | H→C | `protocol` | `language, costModel, unicode, core, saveFormat` | `CoreVersions` / `coreVersions` |
| `define-capability` | H→C | `name, ops: [Operation Declaration]` (a Constant inside is V) | – | `DefineCapability`. The function stays Host-side, keyed by capability and Operation. |
| `standard-capability` | H→C | `name` (`clock`, `calendar`, `locale`, `timer`), `costs` | – | `ClockCapability`, `CalendarCapability`, `LocaleCapability`, `TimerCapability` |
| `define-object-kind` | H→C | `name, props: [{name, shape, readOnly, getCost, setCost}], parentKinds` | – | `DefineObjectKind` |
| `grant` | H→C | `capability, ops` (names, or `"all"`) | `grant` handle | `CapabilityDef.Grant` / `GrantAll`. The binding stays Host-side, keyed by the handle. |
| `compile-library` | H→C | `name, version, source, imports: [identity]` | `identity, needs` | `CompileLibrary` |
| `new-group` | H→C | `name, trace` (bool) | – | `NewGroup`. `OnReady` stays Host-side. |
| `load` | H→C | `name, source, grants: {name: handle}, grantsAsUsed, owner, objects, limits` | `script`, `trace` | `Group.Load` |
| `add-library` / `replace-library` | H→C | `identity` (plus `carry`) | – / `reports` | `AddLibrary` / `ReplaceLibrary` |
| `object` | H→C | `kind, id` | – | `Group.Object`. `Native` stays Host-side. |
| `set-parent` / `dispose` | H→C | `object, parent` / `object` | – | `SetParent` / `Dispose` |
| `deliver` | H→C | `to: {object} or {script}, message: {name, args (V), limits}` | `delivery` | `Group.Deliver`, `Script.Deliver` |
| `request` | H→C | as `deliver` | `delivery`, settled by its `run end` | `Request`. `Pending` stays Host-side. |
| `cancel-request` | H→C | `delivery` | – | Cancelling a Request's `ctx` / `signal` (new) |
| `broadcast` | H→C | `message` | `broadcast` | `Broadcast` |
| `call` | H→C | `fn (V), args (V), limits` | `delivery` | `Group.Call` / `group.call` |
| `answer` | H→C | `call, value (V), fuel` (optional) | – | `Call.Answer`, `AnswerWithCost` / `call.answer(v, {fuel})` |
| `fail` | H→C | `call, error` | – | `Call.Fail` |
| `pump` | H→C | `now, fuelSlice, fuelCap` | `state, nextDeadline, fuelUsed, reports, abandoned, trace` | `Group.Pump` |
| `op` | C→H | `call, script, grant, capability, operation, mode, now, args (V), fuelLeft` | `op-result`: `{result (V)}`, `{started}`, `{done}`, `{fail: error}`, `{limit}` or `{hostError: detail}`, each with `charged` | `Do`, `Start` or `Fire`, and `Call` reads, `Charge` |
| `prop` | C→H | `object, prop`, and `value (V)` for a set | `prop-result`: `{value (V)}`, `{ok}` or `{fail}` | `Prop.Get` / `Prop.Set` |
| `save` / `fingerprint` | H→C | – | `save` / `fingerprint` (bytes) | `Save` / `Fingerprint` |
| `restore` | H→C | `name, save, libraries: [identity], mismatch, trace` | `variablesOnly, pending: [{call, script, operation, args (V)}], discardedRuns, disposed` | `Core.Restore` |
| `resolve` | C→H | `grants: [[script, name]], objects: [[kind, id]]` | `resolve-result`: `grants: [handle or null], objects: [bool]` | `RestoreOptions.Grants` / `Resolve` |
| `settle` | H→C | `call, settlement: {answer (V)}, {fail}, {reissue} or {adopt}` | – | `Group.Settle` |
| `reload` / `extend` | H→C | `source` (plus `carry`) | `reports` / – | `Script.Reload` / `Extend` |
| `stop` / `cancel-run` / `revoke` | H→C | `reason` / `run` / `grant` name | – | `Script.Stop` / `CancelRun` / `Revoke` |
| `counters` / `grants` | H→C | – | `Counters` / `{name: [ops]}` | `Script.Counters` / `Grants` |
| `export-manifest` | H→C | the `ManifestSpec`, by handles | `manifest` (bytes) | `ExportManifest` |

**Reports** are the talk.ts `Report` union written as data:

- **`run end`:** `script, run, delivery, broadcast, handler, outcome, result (V), error, limit, at: {unit, line, col, handler, pc}, fuel, alloc`
- **`stop`:** `script, reason, discardedRuns, droppedMessages, pendingCalls`
- **`unhandled`:** `delivery, message, target`
- **`call failed`:** `script, call, operation, detail`

**Stays on the Host side and never crosses:**

- Grant bindings, and `Object.Native`
- `OnReady`, and the `Pending` or Promise futures
- Value constructors and reads. The binding writes and reads the Value Encoding itself. The Core applies ADR 0030's checks (NFC, 34 digits, duplicate keys) when it decodes, and refuses input the value model can't hold as `invalid value`.
- The `json` codec helpers, the drivers and `Must*` helpers

### How the ids flow

- **Delivery ids** (`d1`, `d2` in the [worked example](../../corpus/examples/orders-pricing/case.trace)) are assigned by the Core when it receives `deliver`, `request` or `call`, in the order it receives them. They are returned in the reply, and carried by that Delivery's `run end` or `unhandled` report and by `cancel-request`. A `broadcast` returns a broadcast id, and each recipient's `run end` carries its own delivery id with it.
- **Run ids** (`orders/r1`) first appear in reports. `cancel-run` takes them, and `stop` lists the discarded ones.
- **Call ids** (`pricing/r1.c1`, then `c2` and so on in start order within a Join) are assigned when the Core issues `op`. The Host uses one in `answer`, `fail` and `settle`. Call ids also come back in `abandoned`, `stop.pendingCalls`, `call failed` and `restore.pending`. An `answer` to an abandoned or ended call is accepted and ignored, as now.
- **Host handles:** grant handles, library identities, Group names, Script names and Host Object `[kind, id]` pairs.
- **Under WASI, sent means received.** A message the Host holds in its outbox during a Pump is received when it is flushed. Its delivery id is assigned then, and `mailbox full` is decided then. That is the same Pump boundary the input queue already gives.

### Values, Host Objects and Function Values

- **Host Objects** cross as `{"$object": [kind, id]}` and are resolved against the message's `group`. The Core can't tell one Group's `["npc", "42"]` from another's, so an Elixir binding makes the `wrong group` check itself, with handles that carry their Group.
- **Text Patterns** cross as `{"$pattern": source}` and are re-parsed when decoded (ADR 0030). A Host only passes them back.
- **Function Values:** ADR 0030 refuses to encode them, but the message layer can't work without them. They appear as `run end` results, as arguments to an Operation with a `function` Shape, inside report errors' `data`, and as the `fn` of `call`. The proposal is a message-layer-only tag, `{"$function": [home, display, token]}`:
  - `home` and `display` give the two reads talk.go allows (`HomeScript`, `String`).
  - `token` is opaque. It holds the Core's own encoding of the value's plain data (ADR 0025: its Home Script, its literal and its captured values), plus the Group and the Home Script's code generation.
  - Because the token is by value, nothing needs releasing, which keeps the README's "lives as long as the Host holds it". The Core checks `wrong group` when it decodes the token, and staleness (`function gone`) when the queue is drained, as now.
  - A handle table would need a `release` message that talk.go doesn't have.
  - The tag is refused by `EncodeValue` for Host storage, since a Host-held handle isn't durable.

## Sidecar versus WASI for an Elixir Host

| | Go Core under `wasip1` in Wasmex | Go Core as a native sidecar on a Port |
|---|---|---|
| **Crossing cost** (this machine) | 17–29 µs for a bare export call. An export making one import took 36–80 µs. One JSON frame in and out through memory took 81–358 µs (alloc, write, call and read, four hops). | 7–10 µs per `{packet, 4}` frame round trip, with an echoing sidecar |
| **Why** | Each call is a `GenServer.call`, then a command queued to a Tokio task that owns the Store ([`instance.rs:324`](https://github.com/tessi/wasmex/blob/d473cd24bce21f35045e8a094c8fb1bbf796f89b/native/wasmex/src/instance.rs#L324), [`store_executor.rs:28-33`](https://github.com/tessi/wasmex/blob/d473cd24bce21f35045e8a094c8fb1bbf796f89b/native/wasmex/src/store_executor.rs#L28)). Memory reads and writes are commands too. This is Wasmex's design, not Wasm's, and Bun makes the same export call in 0.01 µs. | A pipe write and read per frame |
| **Core speed** | 3.5–7× native ([go-wasm spike](go-wasm-spike.md#speed)) | native |
| **Parallelism** | One thread per instance, so Groups in an instance pump serially. More parallelism means more instances, at about 4 MiB and 12 ms each for standard Go ([go-wasm spike](go-wasm-spike.md#instances)). | Groups pump in parallel on the Go scheduler. All traffic still goes through the Port's one connected process ([ports guide](https://www.erlang.org/doc/system/c_port.html)), so heavy Hosts would run several sidecars or use a socket. |
| **BEAM schedulers** | Not blocked: Wasm runs on Wasmex's own Tokio threads ([`engine.rs:9-20`](https://github.com/tessi/wasmex/blob/d473cd24bce21f35045e8a094c8fb1bbf796f89b/native/wasmex/src/engine.rs#L9)). The calling process waits for the reply. An `op` handled as an import runs in the instance's GenServer. | Not blocked: Port I/O is asynchronous |
| **A Core crash** | A trap comes back as `{:error, …}` and the GenServer lives (checked). The instance, and every Group in it, must be discarded and restored from saves (ADR 0009: one instance per trust boundary). | The Port reports `exit_status` (137 when the spike killed it) and the BEAM lives (checked). Every Group in the process is lost. A panic can be recovered natively, but a fatal runtime error can't. |
| **A bug in the glue** | Wasmex and Wasmtime are a NIF, and "a native function that crashes will crash the whole VM" ([erl_nif](https://www.erlang.org/doc/apps/erts/erl_nif.html)) | Outside the VM |
| **Memory cap** | Hard, per Store (`Wasmex.StoreLimits` `memory_size`). Hitting it is a fatal Go OOM (go-wasm spike), so it stays a backstop behind the Allocation Budget. | OS limits only (cgroups, `ulimit`). `GOMEMLIMIT` is soft. |
| **Deployment** | One portable `.wasm` in `priv/`, plus the `wasmex` dependency, whose NIF comes precompiled for common targets (it downloaded for `aarch64-apple-darwin` here) | A Go binary for each target OS and architecture, spawned and supervised by the Host |
| **Stop mid-Pump** | Lands at the next crossing or the end of the Pump | Native: the reader goroutine calls `Script.Stop` while the Pump runs |
| **Queued calls during a Pump** | Held in the binding's outbox | Sent at once. The sidecar's reader goroutine appends them, as talk.go allows from any goroutine. |

For an Elixir Host, then, the sidecar is cheaper per crossing and faster to compute. WASI is simpler to ship and gives a hard memory cap. Neither needs anything special to suspend a Run.

## One message layer for both

Yes. The message set, ids, encodings and the Host-driven exchange (with `op` as an interim reply) are the same on both transports. What differs is the framing, and two rules that follow from WASI being single-threaded: the outbox, and `Stop` landing at a crossing. Both rules are invisible to Scripts and to replay parity. An Elixir binding written against the message layer switches transport by changing how it sends a frame. The same layer could also serve a TS Host that runs the TS Core in a worker, though nothing here needs it.

## Consequences for the ADRs and the interface

These are proposals, not edits.

- **ADR 0030 / ADR 0025:** add `{"$function": [home, display, token]}` as a message-layer-only reference form, which Host storage refuses. The token is by value and carries its Group, so nothing needs releasing.
- **ADR 0015 / README (threads):** say that under the message layer, a queued call is "received" when the Core reads its message. That is when its delivery id is assigned and `mailbox full` is decided. It also makes explicit that the input queue may live partly in the Host's outbox. Say that `Stop` and `CancelRun` land at the latest at the next Host crossing or the end of the Pump. The Go Core's "between instructions" stays as the native behaviour.
- **ADR 0015 (charging):** state that `Charge` fails exactly when the Run's Fuel remaining after the declared cost can't cover it. Then a `fuelLeft` figure in `op` reproduces it without a round trip.
- **Interface:** add `cancel-request` as a message. talk.go and talk.ts express it only as `ctx`/`signal`. Say which Trace Host Input it records, since ADR 0018 lists `cancel-run` but a Delivery still in the mailbox has no run id.
- **Interface:** the abandonment of a Call (its `Context` cancellation) isn't a report kind in talk.go. The message layer adds `abandoned` to the `pump` reply, and the Trace already has `abandon <call-id>` (ADR 0026).
- **ADR 0009:** the "no cheap way to suspend a Run" reason for rejecting one Go→WASM core no longer holds, since the Pump suspends without blocking. The other reasons stand: the crossing cost, whole-instance traps and payload size. The note should say so, so the argument isn't reused.
- **The WASI adapter** is Host-side glue over the ordinary Go embedding API, and not a second Core mode. It runs `Group.Pump` on a goroutine, turns Operation calls into interim replies, and keeps each export's own goroutine from waiting.

## Fog

- **Duration units.** talk.go takes `time.Duration` (nanoseconds) for `MaxPending` and `MaxWait`, and talk.ts takes milliseconds (`maxPendingMs`, `maxWaitMs`). A Go Host can set 1.5 ms, which TS can't express, and the Group Fingerprint covers both declarations and limits. The message layer and the Host Manifest need one unit. Milliseconds match TS, and nanoseconds match the Clock.
- **Should a `timeout` count as abandonment?** When `maxPending` runs out, the Core fails the call with `timeout`. talk.go lists Join failure, cancellation and stop as the reasons `Call.Context` is cancelled, but not timeout. It is unclear whether the Host is told to stop the work.
- **Protocol errors** (an unknown message, a malformed frame, a `ref` out of order) aren't Host errors in the catalogue. They probably need a transport-level error that isn't covered by parity.
- **Large blobs.** Saves go in base64 inside JSON, which costs 33%. A binary side frame may be worth it for big Groups.
- **Wasmex latency** was noisy: one run of export-plus-import averaged 1.3 ms. The cause, whether Tokio wake-ups, the epoch ticker or macOS scheduling, wasn't investigated. It wasn't measured on Linux either.
- **Batching** several queued inputs into `pump` (`inputs: […]`) would save crossings under WASI. It needs delivery ids to be assigned in batch order, which the rules above already give, but the batch form isn't in the table.
- **A display message.** An Elixir Host may want a value's display form, the Trace's form (ADR 0018), for its logs. Only Function Values carry one in this design.
- **An imports-only WASI transport** (option 1) was measured, but its frame handling through `caller` wasn't.

## Reproducing

```sh
cd spikes/message-layer
./run.sh    # builds out/spike.wasm (Go wasip1 reactor) and out/sidecar, then runs Bun and the Elixir checks
```

The `.exs` files fetch Wasmex 0.15.1 through `Mix.install`. Its precompiled NIF is downloaded on first use.
