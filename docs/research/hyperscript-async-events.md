# _hyperscript's async and event model

Research for [#2](https://github.com/odogono/odgn-talk/issues/2). Feeds #9 (execution model), #10 (durability), #12 (runtime architecture) and #13 (syntax sketch).

**Sources.** The _hyperscript source is read at commit [`d35431a`][hs] (v0.9.93, 2026-06-26, per `CHANGELOG.md`). Its official docs live in the same repo under `www/`. HyperTalk details come from the HyperTalk Reference stack as transcribed at hypercard.center. SenseTalk details come from Eggplant's official SenseTalk reference. Where a claim is my inference from code rather than documented behaviour, it says so.

## 1. How async transparency works

**The docs' claim.** The runtime "handles Promises under the covers … resolving them internally, so that asynchronous behavior looks linear". This "decolors functions (and event handlers)" ([docs/async.md][d-async]).

**The mechanism: a sync-first trampoline over a linked list of commands, with promise chaining only at suspension points.**

- **Commands form a linked list.** Each command has a `next` pointer. The parser appends an `ImplicitReturn` to every command list ([parser.js `ensureTerminated`][p-term]). `findNext` walks `next`, a node's own `resolveNext`, or the parent chain ([runtime.js L206][r-findnext]).
- **A command's `resolve()` returns the next command to run.** It returns either a command, the `HALT` sentinel, or a *Promise of* the next command.
- **`unifiedExec` is the trampoline** ([runtime.js L86–143][r-exec]). It runs a `while(true)` loop, stepping from command to command synchronously. When a step returns a thenable, it attaches `.then(resolvedNext => this.unifiedExec(resolvedNext, ctx))` and **returns**, unwinding the JS stack ([L109–119][r-then]). A rejection re-enters the trampoline with a synthetic command that rethrows it, so `catch`/`finally` blocks work across the async boundary (same lines).
- **`unifiedEval` does argument evaluation for every expression and command** ([runtime.js L145–204][r-eval]). It evaluates each arg. If any value is a thenable, it wraps the whole node in `Promise.all(args).then(resolve)`. Otherwise it calls `resolve` directly. The effect is that **promises exist only on paths that actually suspend**. Fully synchronous code allocates none.
- **Suspension state lives on the heap, not on a stack.** The per-invocation `Context` holds `locals`, `me`, `it`/`result`, `event`, and `meta.iterators` ([runtime.js L11–50][r-ctx]). Loop state (index, the iterator, "event fired" flags) is kept in `ctx.meta.iterators[slot]`, so a loop can resume after an `await` ([controlflow.js L340][c-iter]). The "continuation" of a suspended top-level handler is therefore just *(next command pointer, ctx)*.
- **`def` functions are sync-if-possible, promise-if-needed** ([def.js L45–77][d-def]). A call creates a fresh `ctx` and runs `start.execute(ctx)`. If the body finished synchronously (`ctx.meta.returned`), the call returns the plain value. Otherwise it returns a Promise that a later `return` resolves. The caller's `unifiedEval` sees the thenable and suspends in turn. **Nested calls chain promises; nothing captures the JS stack.** Callers from JS just get a Promise ([docs/events.md, Functions][d-events]).
- **The primitives are thin wrappers:**
  - `wait 2s` returns `new Promise(r => setTimeout(() => r(findNext()), time))` ([events.js L94–99][e-wait]).
  - `wait for a or b [from x]` adds a `{once:true}` listener per event, or a `setTimeout` for time alternatives. The first to fire resolves the promise and sets `result` to the event ([events.js L63–92][e-wait]).
  - `fetch` returns the `fetch()` promise chain, which resolves to `findNext` ([basic.js L618–683][b-fetch]).
  - `repeat until event X` sets a flag from a `{once:true}` listener, and the flag is checked at the top of each iteration ([controlflow.js L355–365][c-evt]; [docs/async.md][d-async]).
  - `for x in` accepts async iterators ([controlflow.js L343][c-iter]).
- **Async-aware short-circuiting.** `and`/`or` override `evaluate` to chain on a promised LHS before touching the RHS ([expressions.js L1140–1161][x-logic]).
- **Places where suspension is not allowed.** `on` event filters are evaluated synchronously (`//OK NO PROMISE`, [on.js L202][o-filter]). A promise returned there is truthy, so the filter passes. `evaluateNoPromise` throws if a promise appears in such a context ([runtime.js L640][r-nopromise]).

**Semantic quirks worth not copying (inferred from the code):**

- **Args run concurrently.** A command's args are all evaluated eagerly, left to right, and *then* awaited together with `Promise.all`. So two async args in one command overlap, and a synchronous side effect in a later arg runs before an earlier async arg resolves.
- **Losing waits are never cleaned up.** In `wait for a or 3s`, the losing listener and timer are never removed or cleared ([events.js L86–89][e-wait]).
- **No step metering and no cancellation.** A suspended handler can't be cancelled from outside. Element `cleanup()` removes listeners, observers and debounce timers ([runtime.js L777–819][r-cleanup]), but a pending `wait` still resumes later against the removed element. The only cancellation is ad-hoc, per command: e.g. `fetch` listens for a `fetch:abort` event on `me` ([basic.js L623–626][b-fetch]).

## 2. Event handlers: `on`, filters, `every`, `from`, lifetime

**Grammar** ([features/on.md][d-on]):

```
on [every|first] <event>[(params)][[filter]][count] [from <expr>|elsewhere] [in <expr>] [debounced|throttled at <t>] [or …] [queue all|first|last|none] <commands> [catch e …] [finally …] end
```

**`install()`** ([on.js L79–273][o-install]):

- **Targets.** It resolves the target(s) once, at install time: `from` evaluates its expression then, `elsewhere` means `document`, and the default is `me` ([L85–92][o-from]). Elements that match later are not picked up.
- **Listeners.** It adds a plain DOM listener to each target.
- **Per event, before running the body:**
  - It builds a fresh `Context`.
  - It destructures `(params)` from `event[name]`, falling back to `event.detail[name]`.
  - It runs the filter. The filter's symbols resolve against the event first, then globals ([docs][d-events]).
  - It applies the `in <selector>` delegation match.
  - It checks `count` (`first` is shorthand for count 1).
  - It applies debounce/throttle.
  - Finally it calls `execute(ctx)`.
- **Synthetic events.** `mutation`, `intersection` and `resize` wrap the Observer APIs and re-dispatch as DOM events ([L108–157][o-install]).

**Lifetime:**

- **Listeners.** They are recorded in the element's internal data. `cleanup()` removes them, along with observers and debounce timers ([runtime.js L777][r-cleanup]).
- **When cleanup runs.** It is called when a node is morphed away ([runtime.js L461][r-morph]) or its script changes.
- **Handlers listening to other targets.** For a handler listening on *another* target, removal is also lazy: on the next event the listener checks `elt.isConnected` and removes itself ([on.js L169–172][o-conn]). The docs describe this as "When the element is removed, the listener is removed too" ([features/on.md][d-on]).
- **In-flight executions are not torn down** (see §1).

**Errors.** An uncaught error in a handler with no `catch` is re-dispatched as an `exception` event on the element ([on.js L66–77][o-exec]; [docs][d-events]).

## 3. Queueing: `queue first/last/all/none`, `every`

**Documented behaviour** ([docs/events.md, Event Queueing][d-events]; [features/on.md][d-on]):

- **Default.** "By default, the event handler will use the `queue last` strategy".
- **`every`.** It runs every event immediately, "in parallel".
- **The four strategies:** `none` drops, `all` queues all FIFO, `first` keeps only the first arrival, `last` keeps only the most recent.

**Implementation** ([on.js L36–78][o-exec]):

- **Where the queue lives.** Each *(element, `on` feature)* pair has `{queue:[], executing:false}` ([runtime.js `getEventQueueFor`][r-queue]).
- **If `executing && !every`.** The strategies map to code as follows:
  - `none` returns.
  - `first` returns if the queue is non-empty.
  - `last` truncates the queue.
  - All three then push the new `ctx`.
- **Otherwise.** It sets `executing = true` and installs `ctx.meta.onHalt`. When the run reaches `HALT` (normal end, `exit`, `return`, or an error after `finally`), `onHalt` clears `executing` and schedules the next queued ctx with `setTimeout(…, 1)`.
- **"Busy" means suspended.** A handler is busy exactly while it is suspended. The queue is only reached because a previous run hit an `await`, since synchronous runs finish inside the dispatch.
- **`every` bypasses the check**, so one element can have many concurrent runs of the same handler, each with its own `ctx`. Element-scoped variables (`:count`) are shared between them.
- **Queued events run late.** A queued event is replayed after its original DOM dispatch has finished. Inferred consequence: `halt` in a queued run cannot affect propagation.

## 4. `send`/`trigger`, propagation, halting

- **Dispatch.** `send ev(args) to x` and `trigger ev on x` are the same command ([events.js L109–143][e-send]; [commands/send.md][d-send]). `triggerEvent` builds `new Event(name, {bubbles:true, cancelable:true, composed:true})`, puts args (plus `sender`) in `detail`, and calls `dispatchEvent` ([runtime.js L690–705][r-trigger]).
- **Propagation is entirely the DOM's.** Events bubble up the element tree, cross shadow roots, and handlers match by name. Hyperscript adds no routing of its own.
- **`send` is synchronous and fire-and-forget.** `dispatchEvent()` "invokes all applicable event handlers synchronously before returning" ([MDN][mdn-dispatch]). Inferred from the code:
  - The receiver's handler runs *nested inside the sender's step*, up to its first suspension.
  - Then `send` continues. It never awaits the receiver's completion and gets no reply value.
  - Re-entrancy (A sends to B, and B sends back to A) happens on the JS stack.
- **Halting** ([basic.js L193–240][b-halt]; [docs/events.md, Halting][d-events]):
  - `halt` calls `stopPropagation()` and `preventDefault()`, then exits the handler.
  - `halt bubbling` and `halt default` do one of the two, then exit.
  - `halt the event` does both and keeps running.
  - `exit` and `return` end the handler by returning `HALT`.
  - Inferred: because dispatch is synchronous, **halt/preventDefault only takes effect if it runs before the handler's first suspension**.
- **Cancellation.** The language has no primitive for cancelling a running or suspended handler. Script-side cancellation is done with events: `repeat until event stop` is checked cooperatively at iteration boundaries ([docs/async.md][d-async]), and `fetch` cancels via `fetch:abort`.

## 5. Prior art for unhandled messages: HyperTalk and SenseTalk

**HyperTalk**:

- **The path.** A message goes first to a button/field or the current card, then "the current background, the current stack, the stack script of the Home stack, and HyperCard itself" ([HyperTalk Ref: message-passing order][ht-order]).
- **Delegation is opt-in, not default-bubbling.** Once handled, a message stops. `pass` "ends execution of the current handler and sends the entire message … to the next object in the message-passing order" ([pass][ht-pass]).
- **`send`** delivers "directly to a particular object". If unhandled there, the message "continues along the message-passing path from that point", and `the target` names the original recipient ([send][ht-send]).
- **`start using`** "inserts the specified stack into the message-passing order between the current stack and the Home stack", up to 16 stacks ([start using][ht-using]). This is library injection via the path.
- **Unhandled messages.** Custom messages need not be built-ins. If nothing handles one, HyperCard reports it "can't understand" the message ([Writing message handlers][ht-write]).

**SenseTalk** ([Eggplant SenseTalk: Messages][st-msg]):

- **The path.** Front scripts (plus their helpers), then the target object (plus its helpers), then back scripts (plus their helpers), then the host application and SenseTalk, then "other script files in folders identified by the host application".
- **Helpers.** These are per-object delegates. They are checked, recursively, before the message moves on.
- **`start using`.** It inserts into the back scripts.
- **Passing.** `pass message` terminates the handler. `pass message and continue` delegates and then resumes the current handler.
- **Unhandled messages.** If a message reaches the host and matches a built-in command or function, the built-in runs. Otherwise "an error is raised".

**Contrast with _hyperscript.** DOM bubbling is *opt-out* (a `halt` is needed to stop it), fans out to every matching listener, and silently drops events nobody handles. The xTalk path is *opt-in* (`pass`), stops at the first handler, has a Host-defined chain, and errors on unhandled *commands*.

## Implications for our language

| Mechanism | What an interpreter needs | Carries over to a Go Host? |
|---|---|---|
| Async transparency | A way to suspend a Handler at any await point and resume it later. _hyperscript uses sync-first eval, promise chaining at suspension, heap-held loop state, and a linked-list "next" pointer. It still leans on the JS stack for nested `def` calls and expression evaluation. | **Not as-is.** Go has no promises. There are two faithful options. (a) **An explicit resumable VM**: bytecode plus heap-allocated frames, where suspending means returning from the run loop with the state saved. This is identical in Go and TS, and lets the VM count steps and kill cleanly. It also opens the door to serialising suspended Scripts (#10). (b) **Host-native**: goroutine-per-run in Go and `async` functions in TS. This is cheap to write, but it gives two divergent schedulers, is hard to meter and cancel uniformly, and can't be persisted. For hard multi-tenant parity, (a) is the one to evaluate in #5/#12. |
| Suspension primitives (`wait`, `wait for … or …`, fetch) | Every suspension goes through a Capability, and the scheduler owns it. Each one needs a cancel hook so losing alternatives and killed Scripts release their timers and listeners. That is the leak _hyperscript has. | Yes. Timers and I/O become Host Capabilities returning a completion token. The VM resumes on completion. Wall-clock timers are the one nondeterministic input, so conformance tests need a virtual clock. |
| Step budgets | _hyperscript has none. A resumable VM gives a natural instruction counter. Suspended time must not consume fuel. | Yes, same in both Hosts, if the VM is shared by design rather than per Host. |
| `on` handlers, filters, counts, destructured params | Handler registration per (object, message). Filters/Guards evaluated **synchronously and side-effect-free**. _hyperscript already forbids async filters, which lines up with Elixir-style Guards (#4). | Yes. It is pure interpreter logic, with the Host supplying the event objects. |
| Handler lifetime | Handlers are bound to a Host object's lifetime. Teardown must also cancel *in-flight* suspended runs, which _hyperscript does not do. | Yes, but it needs an explicit Host API ("object disposed"). There is no `isConnected` to poll outside the DOM. |
| Queueing (`every`, `queue last/first/all/none`) | A per-(object, Handler) mailbox plus a "running" flag, released on halt. The default is `queue last`. Queue depth must count against the memory cap. | Yes, trivially. This is the natural place to define ordering guarantees for #9. |
| `send` and propagation | _hyperscript delegates everything to DOM dispatch: synchronous, re-entrant, bubbling, fire-and-forget. We have no DOM in Go or Bun, so **we must define dispatch ourselves**. An xTalk message path fits a Host-defined object model better: target → helpers → Host-declared parent chain → Script/library level → Host built-ins → "can't understand" error. Opt-in `pass` also composes with Handler Clauses: when no clause matches, the message passes on. | Yes, and uniformly, because it is interpreter-owned rather than borrowed from the DOM. In the browser the Host can bridge DOM events into it. |
| Halting / veto | Sync-only halt is an accident of DOM dispatch. If Hosts need veto semantics ("before save"), the spec must say whether the veto window closes at the first suspension or the dispatcher awaits the Handler. | Only if the spec defines it. There is nothing to inherit from the DOM. |
| Cancellation | Script-side: event-driven, cooperative loops (`repeat until event`) are worth keeping. Host-side: a hard kill that drops continuations and cancels pending Capabilities. | Yes, with a resumable VM. With goroutines it needs context plumbing everywhere. |

**Don't copy:** concurrent `Promise.all` evaluation of one command's arguments (evaluate sequentially instead), leaked `wait … or …` alternatives, and uncancellable suspended runs.

[hs]: https://github.com/bigskysoftware/_hyperscript/tree/d35431abe4d7d1bcdc29a346f41a5208e6e93e9e
[r-exec]: https://github.com/bigskysoftware/_hyperscript/blob/d35431abe4d7d1bcdc29a346f41a5208e6e93e9e/src/core/runtime/runtime.js#L86-L143
[r-then]: https://github.com/bigskysoftware/_hyperscript/blob/d35431abe4d7d1bcdc29a346f41a5208e6e93e9e/src/core/runtime/runtime.js#L109-L119
[r-eval]: https://github.com/bigskysoftware/_hyperscript/blob/d35431abe4d7d1bcdc29a346f41a5208e6e93e9e/src/core/runtime/runtime.js#L145-L204
[r-findnext]: https://github.com/bigskysoftware/_hyperscript/blob/d35431abe4d7d1bcdc29a346f41a5208e6e93e9e/src/core/runtime/runtime.js#L206-L216
[r-ctx]: https://github.com/bigskysoftware/_hyperscript/blob/d35431abe4d7d1bcdc29a346f41a5208e6e93e9e/src/core/runtime/runtime.js#L11-L50
[r-nopromise]: https://github.com/bigskysoftware/_hyperscript/blob/d35431abe4d7d1bcdc29a346f41a5208e6e93e9e/src/core/runtime/runtime.js#L640-L646
[r-trigger]: https://github.com/bigskysoftware/_hyperscript/blob/d35431abe4d7d1bcdc29a346f41a5208e6e93e9e/src/core/runtime/runtime.js#L690-L705
[r-queue]: https://github.com/bigskysoftware/_hyperscript/blob/d35431abe4d7d1bcdc29a346f41a5208e6e93e9e/src/core/runtime/runtime.js#L721-L734
[r-cleanup]: https://github.com/bigskysoftware/_hyperscript/blob/d35431abe4d7d1bcdc29a346f41a5208e6e93e9e/src/core/runtime/runtime.js#L777-L819
[r-morph]: https://github.com/bigskysoftware/_hyperscript/blob/d35431abe4d7d1bcdc29a346f41a5208e6e93e9e/src/core/runtime/runtime.js#L458-L469
[p-term]: https://github.com/bigskysoftware/_hyperscript/blob/d35431abe4d7d1bcdc29a346f41a5208e6e93e9e/src/core/parser.js#L321-L328
[d-def]: https://github.com/bigskysoftware/_hyperscript/blob/d35431abe4d7d1bcdc29a346f41a5208e6e93e9e/src/parsetree/features/def.js#L45-L77
[e-wait]: https://github.com/bigskysoftware/_hyperscript/blob/d35431abe4d7d1bcdc29a346f41a5208e6e93e9e/src/parsetree/commands/events.js#L63-L101
[e-send]: https://github.com/bigskysoftware/_hyperscript/blob/d35431abe4d7d1bcdc29a346f41a5208e6e93e9e/src/parsetree/commands/events.js#L109-L143
[b-fetch]: https://github.com/bigskysoftware/_hyperscript/blob/d35431abe4d7d1bcdc29a346f41a5208e6e93e9e/src/parsetree/commands/basic.js#L618-L683
[b-halt]: https://github.com/bigskysoftware/_hyperscript/blob/d35431abe4d7d1bcdc29a346f41a5208e6e93e9e/src/parsetree/commands/basic.js#L193-L240
[c-iter]: https://github.com/bigskysoftware/_hyperscript/blob/d35431abe4d7d1bcdc29a346f41a5208e6e93e9e/src/parsetree/commands/controlflow.js#L335-L354
[c-evt]: https://github.com/bigskysoftware/_hyperscript/blob/d35431abe4d7d1bcdc29a346f41a5208e6e93e9e/src/parsetree/commands/controlflow.js#L355-L365
[x-logic]: https://github.com/bigskysoftware/_hyperscript/blob/d35431abe4d7d1bcdc29a346f41a5208e6e93e9e/src/parsetree/expressions/expressions.js#L1140-L1161
[o-exec]: https://github.com/bigskysoftware/_hyperscript/blob/d35431abe4d7d1bcdc29a346f41a5208e6e93e9e/src/parsetree/features/on.js#L36-L78
[o-install]: https://github.com/bigskysoftware/_hyperscript/blob/d35431abe4d7d1bcdc29a346f41a5208e6e93e9e/src/parsetree/features/on.js#L79-L273
[o-from]: https://github.com/bigskysoftware/_hyperscript/blob/d35431abe4d7d1bcdc29a346f41a5208e6e93e9e/src/parsetree/features/on.js#L85-L92
[o-conn]: https://github.com/bigskysoftware/_hyperscript/blob/d35431abe4d7d1bcdc29a346f41a5208e6e93e9e/src/parsetree/features/on.js#L169-L172
[o-filter]: https://github.com/bigskysoftware/_hyperscript/blob/d35431abe4d7d1bcdc29a346f41a5208e6e93e9e/src/parsetree/features/on.js#L198-L208
[d-async]: https://github.com/bigskysoftware/_hyperscript/blob/d35431abe4d7d1bcdc29a346f41a5208e6e93e9e/www/docs/async.md
[d-events]: https://github.com/bigskysoftware/_hyperscript/blob/d35431abe4d7d1bcdc29a346f41a5208e6e93e9e/www/docs/events.md
[d-on]: https://github.com/bigskysoftware/_hyperscript/blob/d35431abe4d7d1bcdc29a346f41a5208e6e93e9e/www/features/on.md
[d-send]: https://github.com/bigskysoftware/_hyperscript/blob/d35431abe4d7d1bcdc29a346f41a5208e6e93e9e/www/commands/send.md
[mdn-dispatch]: https://developer.mozilla.org/en-US/docs/Web/API/EventTarget/dispatchEvent
[ht-order]: https://www.hypercard.center/HyperTalkReference/hypertalkbasics/The-message-passing-order
[ht-pass]: https://www.hypercard.center/HyperTalkReference/keywords/pass
[ht-send]: https://www.hypercard.center/HyperTalkReference/keywords/send
[ht-using]: https://www.hypercard.center/HyperTalkReference/commands/start-using
[ht-write]: https://www.hypercard.center/HyperTalkReference/Writing-message-handlers
[st-msg]: https://docs.eggplantsoftware.com/epf/25.1/stk-messages/
