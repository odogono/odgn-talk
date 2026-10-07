# 5. Handlers, messages and scheduling

_Draws on:_ [ADR 0004](../docs/adr/0004-scripts-are-actors.md), [ADR 0006](../docs/adr/0006-limit-faults-roll-back-the-segment.md), [ADR 0009](../docs/adr/0009-twin-cores-held-to-bit-for-bit-parity.md), [ADR 0010](../docs/adr/0010-normative-lowering-onto-a-stack-abstract-machine.md), [ADR 0015](../docs/adr/0015-the-host-drives-the-core-through-a-pump.md), [ADR 0016](../docs/adr/0016-messages-reach-scripts-through-core-owned-object-parents.md), [ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md), [ADR 0020](../docs/adr/0020-scripts-share-code-through-stateless-libraries.md), [ADR 0021](../docs/adr/0021-the-stdlib-is-a-small-built-in-core-plus-libraries-written-in-the-language.md), [ADR 0025](../docs/adr/0025-lambdas-are-first-class-function-values-that-run-in-their-home-script.md), [ADR 0026](../docs/adr/0026-a-join-starts-several-calls-from-one-run-and-suspends-once.md), [ADR 0031](../docs/adr/0031-a-decisions-verdict-is-sealed-at-the-end-of-its-first-segment.md), [ADR 0042](../docs/adr/0042-block-ending-suffixes-are-optional-and-explicitness-is-lint-advice.md), [ADR 0055](../docs/adr/0055-handlers-name-their-parameters-with-argument-labels-that-join-the-selector.md), [ADR 0057](../docs/adr/0057-a-send-may-compute-its-message-name.md), [ADR 0064](../docs/adr/0064-a-fallback-handler-receives-messages-no-clause-matches.md).

This chapter says how a message reaches a Handler, how Runs of one Script interleave, and how a Pump schedules the Scripts of a Group. The syntax of Handlers and of the statements here is in [chapter 2](02-grammar.md). What happens when something fails is in [chapter 6](06-errors-and-limits.md), and the Host calls that feed the scheduler are in [chapter 9](09-embedding.md).

## Scripts and Runs

- **A Script is an actor.** It has one FIFO mailbox and never executes two steps at the same instant. A new Run may start while other Runs of the same Script are suspended ([ADR 0004](../docs/adr/0004-scripts-are-actors.md)).
- **A Run** is one execution of a Handler, from the message that starts it to its end. It starts when its message leaves the mailbox, and dispatch is its first code ([ADR 0010](../docs/adr/0010-normative-lowering-onto-a-stack-abstract-machine.md)).
- **Segments:** a Run is split into Segments by its Suspension Points. Runs of one Script interleave only there, so no other Run of the Script sees or changes its Script Variables in the middle of a Segment.
- **Preemption isn't suspension:** a Run preempted by its Fuel Slice, or by a TS Core yielding to its event loop, is still in the middle of its Segment. No other Run of its Script proceeds until that Segment ends.
- **Per Run:** locals and `it` belong to the Run. Script Variables belong to the Script and are shared by all its Runs.
- **Outcomes:** every Run ends with exactly one outcome, which its `run end` report carries.

| Outcome | The Run |
| --- | --- |
| `completed` | reached the end of its Handler, a `return`, a `veto` or a `pass` |
| `errored` | ended with an uncaught error ([chapter 6](06-errors-and-limits.md#uncaught-errors)) |
| `limit fault` | exceeded a resource limit ([chapter 6](06-errors-and-limits.md#limit-faults)) |
| `effect failed` | a definite failure prevented Segment participant commit ([chapter 6](06-errors-and-limits.md#effect-failures)) |
| `cancelled` | was cancelled by `, replacing`, `CancelRun` or `cancel-delivery` ([chapter 6](06-errors-and-limits.md#cancellation-and-stop)) |
| `unhandled` | found no Handler Clause that matched its message, nor a [Fallback Handler](#the-fallback-handler) clause |
| `dropped` | was ended at dispatch by a `, dropping` clause |

A Run discarded by Stop Script, by disposing its Script's owner or by a Reload has no `run end`. The `stop` report lists it ([chapter 9](09-embedding.md)).

## Handlers and dispatch

- **Clauses:** every `on m` Handler in a Script is a Handler Clause for the message `m`, and a message's clauses are tried in source order. A message is named by its Selector: `on move piece to square` is a clause for `move:to:`, never for `move` ([chapter 2](02-grammar.md#argument-labels)).
- **Dispatch** tries each clause in turn. A clause matches when the message has as many arguments as the clause has parameters, each argument passes its parameter's Destructuring pattern, and then the Guard, if there is one, gives `true`. The first clause that matches runs, with its parameters bound.
- **No match:** if no clause matches, the Script's [Fallback Handler](#the-fallback-handler), if it has one, gets the message next. If nothing matches there either, the Run ends as `unhandled`, and the message goes on along the [Message Path](#the-message-path).
- **Charged to the Run:** dispatch is the Run's own code, so every clause it tries is charged to it by the Cost Model ([chapter 8](08-the-abstract-machine-and-the-cost-model.md)), even when no clause matches.
- **Never suspends:** dispatch, Guards and the walk along the Message Path never suspend.
- **Guards** may call Built-ins, and nothing else: no Script or Library function and no Function Value. Of a Host Object's properties, a Guard may read only its id (`where the id of item is "object-slot-183"`), and it may call `isDisposed` and `objectKind`. The loader checks this.
- **An error in a Guard** skips the clause, and dispatch goes on to the next one. `try`, `on error` and the reports never see it. The Trace records the skip and the error's code.
- **Imported Handlers are never entry points:** a message never runs a Handler a Script imported from a Library, and a Library never joins a Message Path ([ADR 0020](../docs/adr/0020-scripts-share-code-through-stateless-libraries.md)).

> **Example.**
>
> ```talk
> on handle {type: "invoice", amount: a} as inv where a > 1000
>   send review with inv to approvals
> end handle
>
> on handle {type: "invoice"} as inv
>   send file with inv to ledger
> end handle
> ```
>
> An invoice for 2000 runs the first clause. One for 50 fails the first clause's Guard and runs the second.

### Calling a Handler by name

- **Resolution:** a Command Call (`greet "Ann"`, `move knight to "e4"`) resolves, by its Selector, to a Handler of the Script itself, then to an imported one. Only if neither exists is it sent up the Message Path from the parent of `me`'s object, as `send` would send it, and with `and wait` as `send … and wait`. Since a name clash between the two is a load error, the order never breaks a tie.
- **A plain call:** a Command Call to a Handler of the Script, or an imported one, runs in the caller's Run, through the same clause dispatch. If no clause matches, it raises `no match`. Its errors unwind straight into the caller ([ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md)).
- **The result** of a Command Call, the value its Handler returns, is left in `it`.
- **Called function-style** (`f(x)` or `the f of x`), a Handler, like a function, may never suspend. Reaching a possible Suspension Point through one is a load error.

### Replies

- **A Handler's result** is the value of the `return` that ends it. A bare `return`, reaching `end` and `veto` all give Nothing.
- **The reply** to a `send … and wait`, a `Request` or a Function Value call is the result of the Run that ends the message. A Run that passes the message doesn't end it, so the reply comes from further up the Message Path.

## The Message Path

- **Owning Scripts:** a Host Object has at most one Owning Script, set when that Script is loaded. The Core holds each object's parent, and the Host changes it with `setParent` ([ADR 0016](../docs/adr/0016-messages-reach-scripts-through-core-owned-object-parents.md)).
- **Delivery to an object:** a message addressed to an object goes to the mailbox of its Owning Script, or else to that of its nearest ancestor that has one. If no ancestor has one, the message is reported as `unhandled`, and what that means is up to the Host, for each kind of object.
- **Walked at dispatch:** the path is read from the parents the Core holds when the message reaches the head of its mailbox, before observing any `wait for` or starting a Run. A disposed object drops out of the chain, so the walk skips to its parent. An object-addressed message waiting in a mailbox follows its object if the object moves. If its nearest Owning Script has changed, the message leaves the old mailbox and joins the new one at its tail, keeping its Target, delivery and reply ids. This move starts no Run and spends no Fuel; the new Script dispatches it on its own turn. If there is no remaining Owning Script, the message is `unhandled` without a Run. A Run already started, including one preempted during dispatch or parked by a Queueing Policy, stays in its Script.
- **Moved-message admission:** moving an already admitted message is not a new admission: it joins the destination mailbox even past its depth, like a Host Delivery drained after its depth was checked. New sends and climbs still check depth. A moved or climbed message uses the receiving Script’s limits, with each Host override applied as an additional cap; it can never loosen those limits.
- **Climbing:** when a Run ends `unhandled`, or its Handler reaches `pass` or `pass any message`, the message goes on from the parent of the object whose Owning Script received it. It goes to the mailbox of the next Owning Script up the path, behind the messages already there. While waiting there, the message reads its path from the current parent of the last object whose Owning Script handled it; it does not restart from the Target. If that mailbox is full at the climb, the climb ends: the Trace records a `note`, and the message is reported as `unhandled`.
- **The end of the path:** a message that climbs past the last object with an Owning Script is reported as `unhandled`. A `send … and wait` or `Request` for it fails with `send failed`, reason `unhandled`.
- **Messages to a Script:** a message addressed to a Script rather than an object (`script.Deliver`, or a `send` to a Script) goes to that Script's mailbox. If it isn't handled, it climbs from the parent of the Script's owner. A Script with no owner reports it as `unhandled`.

### `me`, `the target` and `pass`

- **`me`** is the object the Script owns, or Nothing if it owns none.
- **`the target`** is the object the message was delivered to. It stays the same all the way up the path. For a message sent to a Script, `the target` is the receiving Script's owner, or Nothing if it has none.
- **`pass m`** ends the Run as `completed` and sends the message on up the path, as if no clause had matched. `m` must be the message the Handler handles, or it is a load error. A labelled message is named by its words, without parameters: `pass move to`.
- **Where they can't go:** `pass` and `the target` are load errors inside a Lambda ([ADR 0025](../docs/adr/0025-lambdas-are-first-class-function-values-that-run-in-their-home-script.md)), and `me`, `the target` and `pass` are load errors in Library code ([ADR 0020](../docs/adr/0020-scripts-share-code-through-stateless-libraries.md)).

> **Example.**
>
> ```talk
> on keypress k
>   if k is "escape" then closeDialog else pass keypress
> end keypress
> ```

### The Fallback Handler

A Script's Fallback Handler, `on any message m`, takes the messages none of its Handler Clauses matches ([ADR 0064](../docs/adr/0064-a-fallback-handler-receives-messages-no-clause-matches.md)).

- **When it runs:** after dispatch has tried every clause for the message's Selector and none matched, including when the Script has no Handler for it, and before the message climbs. An explicit `pass m` in a named clause skips the Fallback and climbs at once.
- **Which messages:** a message sent to an object or to a Script, by a `send`, a Host Delivery or Request, or a climb, may reach it, in each Script on its path. A [Broadcast](#broadcast), a [Decision](#decisions) and an `error` message never do, anywhere on their path: they dispatch as if the Script had no Fallback. Neither does a local Command Call, which still raises `no match`, nor a Function Value call, which has no clauses.
- **The message:** `m` is bound to the map `{name, args}`, as `wait for`'s `it` gives it: the Selector as text, and the arguments as a list.
- **Clauses:** a Fallback may have several clauses, each with one Destructuring pattern on the message map and an optional Guard, tried in source order after the named clauses, by the same rules. If none matches, the Run ends `unhandled`. Each clause may have a [Queueing Policy](#queueing-policies). `, deciding` and `, during` on a Fallback are load errors (`bad suffixes`), and so is a Fallback in a Library (`not in a library`).
- **Ending the message:** a Fallback Run that doesn't pass ends the message, with the Run's outcome, and its result is the [reply](#replies). `pass any message` ends the Run as `completed` and sends the message on up the path unchanged, as `pass` does. In a Fallback, `pass` must name `any message`, and `pass any message` outside one is a load error (`wrong message`).
- **Forwarding:** with a [computed name](#sending) and a spread, a Fallback can forward a message whose Selector and argument count it doesn't know.

> **Example.**
>
> ```talk
> on any message {name: n, args: a} where n begins with "debug"
>   send (n) with ...a to logger
> end any message
>
> on any message m
>   say "I don't know how to " & the name of m
> end any message
> ```

### Broadcast

- **Who gets it:** `group.Broadcast` delivers a message only to the Scripts that want it when the Broadcast is drained: those with a Handler for it, or a `wait for` pending on it. A [Fallback Handler](#the-fallback-handler) doesn't make a Script want it. Scripts that don't want it pay nothing.
- **Recipients** are taken in the order their Scripts were loaded into the Group. Each gets its own Delivery id under one broadcast id, and the Trace records the recipients.
- **It never climbs:** a Broadcast is never reported as `unhandled` and never climbs a Message Path. A recipient none of whose clauses matches never runs its Fallback.

## Sending

- **`send m with args to x`**, or `send to x: m args` with the receiver first, puts the message at the back of the receiver's mailbox and returns at once. The target-first form takes [Argument Labels](02-grammar.md#argument-labels), so `send to board: move knight to "e4"` sends `move:to:` with two arguments. It isn't a Suspension Point. The receiver is `me`, another Script of the Group, or a Host Object. Across Groups, the Host routes.
- **A computed name:** `send (e) with args to x` sends the message whose name is the text `e` gives: a Name such as `"greet"`, or a Selector such as `"move:to:"` with one argument for each part. So `send (the name of it) with x to log` forwards a one-argument message that `wait for` saw. The name is checked before the receiver, and before anything is sent. A name that isn't text raises `wrong kind`, with `expected` `"text"`. Text that isn't a Name or a Selector, or that is `all` or a Reserved Word, or a Selector with a part count other than the number of arguments, raises `bad message name`, with `name` and `arguments`. A well-formed name that no Handler takes climbs the [Message Path](#the-message-path) like any other message. Only the receiver-last form computes its name, since a Selector already holds its labels ([ADR 0057](../docs/adr/0057-a-send-may-compute-its-message-name.md)).
- **A spread:** in the receiver-last form, `...e` in the `with` list stands for the items of the list `e`, in order, anywhere in the list and as often as in a list literal. So `send (the name of m) with ...(the args of m) to other` forwards a message with any number of arguments. A spread value that isn't a list raises `wrong kind`, with `expected` `"list"`, before the name is checked. A computed name is then checked against the total number of arguments ([ADR 0064](../docs/adr/0064-a-fallback-handler-receives-messages-no-clause-matches.md)).
- **Order:** mailboxes are FIFO, so two messages from one sender to one receiver are dispatched in the order they were sent.
- **Never nested:** the receiver never runs inside the sender. A `send` to `me` goes through the mailbox too. In a Script that owns no object, where `me` is Nothing, `send … to me` sends to the Script itself.
- **A full mailbox:** a `send` that finds the receiver's mailbox full raises `mailbox full`, with `to`, at the `send`, even one that doesn't wait. Nothing is sent. `to` is the receiver as the `send` named it: a Host Object, `me`'s object included, or a Script's name as text, since a Script isn't a value.
- **Naming a Script:** in a `send`'s receiver, a Name that resolves to nothing else ([chapter 4](04-expressions-and-statements.md#resolving-a-name)) names a Script of the Group by its name, even one loaded later. Whether the Group holds it is checked when the message is sent.
- **A disposed object:** a `send` to a disposed Host Object raises `object gone`, with `object`, before anything is sent. So does a `send` to a Script the Group doesn't hold, with `object` its name as text.
- **`send … and wait`** sends the same way, then suspends until the message is ended. The reply is left in `it`. If no reply comes, the Run raises `send failed`, with `reason`: the outcome of the receiver's Run (`errored`, `limit fault`, `effect failed`, `cancelled`, `unhandled` or `dropped`), or `stopped`. For `errored`, `error` is the receiver's error map ([chapter 6](06-errors-and-limits.md#errors-across-scripts)).
- **The receiver's limits:** a Run started by a Script's own `send` runs on the receiving Script's limits.
- **Cancelling the sender** never cancels the receiver. It keeps running, and its reply is dropped. The same holds when the sender's wait runs out with `timeout`, or when the send is an abandoned Join Member.

### Function Values in another Script

A Function Value runs in its Home Script ([ADR 0025](../docs/adr/0025-lambdas-are-first-class-function-values-that-run-in-their-home-script.md)).

- **From the Home Script,** a call is an ordinary call in the caller's Run.
- **From another Script,** a call is a message to the Home Script. It goes into the Home Script's mailbox, and runs there as a Run on the Home Script's Fuel, Segments and Grants. It is always a possible Suspension Point, so it must be written `f(x) and wait`, and without `and wait` it raises `would suspend`. It fails as `send … and wait` does, and has no Handler Clause, so it runs concurrently.
- **A stale value** raises `function gone` before anything is sent.

## Suspension Points

- **The Suspension Points** are `wait`, `wait for`, `send … and wait`, a call to a suspending Operation (`ask … and wait`), a Command Call to a Handler that may suspend (`name … and wait`), a Function Value called with `and wait`, and the closing `end` of a Join. A Join is marked by its `wait for all` head; its closing `wait` suffix is optional. Every other Suspension Point is written with `wait` at the point itself, so every possible Suspension Point remains known when the Script loads ([ADR 0004](../docs/adr/0004-scripts-are-actors.md), [ADR 0025](../docs/adr/0025-lambdas-are-first-class-function-values-that-run-in-their-home-script.md)).
- **Checked both ways:** `ask … and wait` on an immediate Operation, and `ask` without it on a suspending one, are load errors. So are `name … and wait` for a Handler that can't suspend, and a Command Call without it to one that may. `and wait` on a Function Value that can't suspend is allowed, since the loader can't know which value a variable holds, and then it doesn't suspend.
- **May suspend:** the loader infers which Handlers may suspend over the call graph, including imported Handlers, and reaches a fixpoint for recursion. A Lambda whose body holds a Suspension Point is may-suspend, and the flag is part of its value.
- **Never suspend:** functions, Handlers called function-style, Guards, dispatch and Built-ins. A call without `and wait` never suspends.
- **`finally`** blocks may contain no Suspension Point, checked at load ([chapter 6](06-errors-and-limits.md#catching)).
- **Waiting on an answer:** a suspending Operation call waits at most its Operation's `maxPending`, or else the Script's `MaxWait`. A `send … and wait`, and a call to a Function Value in another Script, wait at most `MaxWait`. When the time runs out, the call is abandoned and the Run raises `timeout` ([chapter 6](06-errors-and-limits.md#limits)).

## Waiting

### `wait` for a time

- **`wait d`** suspends the Run for the exact duration `d`. Anything that isn't an exact duration Quantity raises `wrong kind`: a Quantity of another Unit Kind, or a calendar duration, with `expected` `"s"` and `got` its Unit, and anything else with `expected` `"quantity"`.
- **Its deadline** is the Clock reading of the Pump in which the `wait` ran, plus `d`. It fires at the first later Pump whose Clock reading is at or past the deadline, so it never resumes in the Pump that started it, even for `wait 0 s`.
- **In Libraries:** Library code may use `wait d` ([ADR 0020](../docs/adr/0020-scripts-share-code-through-stateless-libraries.md)).

### `wait for` a message

- **A one-shot subscription:** `wait for m p1, p2` suspends until a message `m` whose arguments pass the patterns reaches the Script. As for a Handler Clause, the message has exactly as many arguments as the event has patterns, so `wait for ready` matches only a `ready` with none. Only a message that is dispatched after the wait began can match. Nothing is buffered, so a missed message stays missed.
- **It observes:** when a message is dispatched, every pending `wait for` in the Script that it matches resumes, in the order the waits began, and then the message goes to the Handler Clauses as usual. A `wait for` never consumes a message.
- **`from x`** evaluates `x` once when waiting begins. A Host Object requires the message’s Target to be that same object, including for a message sent to a Script whose owner is the Target. A Name that names a Script requires that Script to be the sender, as a `send`'s receiver names a Script ([Sending](#sending)). Any other value raises `wrong kind`, expected `object`, before the wait starts. Each block branch keeps its own evaluated filter.
- **`it`:** a `wait for` that matches leaves the message in `it`, as the map `{name, args}`: its Selector as text (`"move:to:"`, or `"move"` for a message with no labels) and its arguments as a list.
- **A timeout:** `wait for m or d` stops waiting after the exact duration `d`, with the same deadline rule as `wait`, and leaves Nothing in `it`. A `wait for` with no timeout can wait for ever. `MaxWait` doesn't apply to it.
- **The block form:** `wait for` at the end of a line takes `when` branches, each an event with an optional Guard, and `after` branches, each a duration. The first branch to fire runs its body, the others are cancelled, and the Run goes on after the closing `end` (optionally `end wait`). A `when` that fires leaves its message in `it`, and an `after` leaves Nothing. When one message matches several `when` branches, the first in source order fires. When several `after` branches are due at the same Pump, the one with the earliest deadline fires, and of equal deadlines, the first in source order.
- **Guards** on `when` branches follow the rules for Handler Guards. An error in one means the branch doesn't match.
- **Decisions:** a `wait for` that takes a Decision allows it at once ([ADR 0031](../docs/adr/0031-a-decisions-verdict-is-sealed-at-the-end-of-its-first-segment.md)).
- **Not in Libraries:** `wait for` is a load error in Library code.

> **Example.**
>
> ```talk
> on awaitPayment order
>   put the id of order into orderId
>   send pay with order to payments
>   wait for
>     when paid {order: o} where o = orderId then
>       ship order
>     when failed {order: o, reason: r} where o = orderId then
>       send refused with r to customer
>     after 2 min then
>       cancelOrder order
>   end wait
> end awaitPayment
> ```

## Joins

A Join, `wait for all … end` (optionally `end wait`), starts several calls from one Run and suspends once, at its closing `end` ([ADR 0026](../docs/adr/0026-a-join-starts-several-calls-from-one-run-and-suspends-once.md)).

- **Members:** every `ask … and wait` and `send … and wait` that the Join's body reaches is a Join Member, including inside `if`, `repeat` and `match`. A call inside a Lambda in the body belongs to the Lambda. Each member is started where it stands and isn't waited for, and it leaves `it` unchanged. Plain `send`, `tell` and immediate `ask` run where they stand, as anywhere else.
- **Call ids** are given to members in start order, like any call's.
- **The result:** when every member has answered, `it` is the list of their answers in start order. Its length is the number of members started, which can vary at run time. Each answer is converted and charged when the Run resumes, in start order. Answers that arrive early count toward Persistent State while the Run waits.
- **No members:** a Join that starts no member sets `it` to `[]` at once, with no suspension and no Segment boundary.
- **Failing fast:** the first member failure to arrive resumes the Run and is raised at the Join's closing `end` ([chapter 6](06-errors-and-limits.md#errors-across-scripts)). The members still pending are abandoned.
- **Failing to start:** a failure to start a member (`mailbox full`, `capability revoked`), or a `throw` in the body, raises at that statement, and the members already started are abandoned.
- **Abandoned members:** an abandoned Capability call gets a cancellation signal on its `Call`, a context in Go and an AbortSignal in TS, which the Host may honour, and an answer that arrives later is ignored. An abandoned send member's receiver keeps running, and its reply is dropped.
- **Width:** starting a member past `MaxJoin` is a Limit Fault at that statement.
- **Each member** is charged Fuel as the same call outside a Join would be, pending members count toward Persistent State, and each member's own `maxPending` or `MaxWait` applies.
- **Also in a Lambda:** a Join may sit in a block Lambda, which is then may-suspend.
- **Load errors in a Join's body:**
  - `wait`, `wait for` or a nested Join, since the Join's closing `end` is its only Suspension Point.
  - A Command Call written `name … and wait`, or `f(x) and wait`, since both may run in this Run. The fix is `send name … to me and wait`.
  - `return`, `veto`, `pass`, or an `exit repeat` or `next repeat` whose loop is outside the Join.
  - A member inside a `try` in the body. A `try` goes around the whole Join.
  - A Join with no member in its source.

> **Example.**
>
> ```talk
> on compare stations
>   wait for all
>     repeat for each s in stations
>       send allReadings with s to me and wait
>     end repeat
>   end wait
>   put it into perStation
> end compare
> ```

## Queueing Policies

A Handler Clause's Queueing Policy says what happens when a message dispatches to it while an earlier Run of the same clause hasn't ended. The policy belongs to the clause, not to the message, and dispatch picks the clause first ([ADR 0016](../docs/adr/0016-messages-reach-scripts-through-core-owned-object-parents.md), [ADR 0026](../docs/adr/0026-a-join-starts-several-calls-from-one-run-and-suspends-once.md)).

- **No suffix:** the new Run goes on at once, and the clause's Runs interleave at their Suspension Points.
- **`, queued`:** if an earlier Run of the clause hasn't ended, the new Run parks right after dispatch, in a FIFO queue for its clause. When the clause's running Run ends, the first parked Run becomes ready, behind the `error` message an errored Run sends ([chapter 6](06-errors-and-limits.md#uncaught-errors)). The mailbox keeps flowing, dispatch Fuel is charged once, and a parked Run counts toward Persistent State.
- **`, dropping`:** if an earlier Run of the clause hasn't ended, the new Run ends right after dispatch, with outcome `dropped`.
- **`, replacing`:** every earlier Run of the clause that hasn't ended is cancelled ([chapter 6](06-errors-and-limits.md#cancellation-and-stop)), and then the new Run goes on.
- **`, deciding`** marks a clause that may hold a Decision's Verdict ([below](#decisions)). It isn't a Queueing Policy, and combines with `, dropping` or `, replacing`.
- **Combining suffixes:** a head has at most one of `queued`, `dropping` and `replacing`, and each suffix at most once. `, queued` with `, deciding` is a load error. `, during name` is allowed only on `on error` ([chapter 6](06-errors-and-limits.md#uncaught-errors)).
- **Foreign Function Value calls** have no clause, so they run concurrently.
- **Joins through `me`:** a Join that sends to `me` runs its members concurrently unless the target clause opts out. With `, queued` they run one at a time, and with `, dropping` or `, replacing` the Join fails fast with `send failed`.

> **Example.**
>
> ```talk
> on save doc, queued
>   ask storage to save doc and wait
> end save
>
> on search term, replacing
>   send query with term to index and wait
>   showResults it
> end search
> ```

## Decisions

A Decision is a Delivery by which the Host asks whether something may happen, and it is answered with a Verdict: allowed, vetoed or undecided ([ADR 0031](../docs/adr/0031-a-decisions-verdict-is-sealed-at-the-end-of-its-first-segment.md)). The Host calls, the reports and cancellation are in [chapter 9](09-embedding.md#decisions).

- **Through the mailbox:** a Decision goes through the FIFO mailbox like any Delivery. A suspended Run doesn't hold it up, and a preempted Run holds it up until that Segment ends.
- **Who decides:** the first `, deciding` clause the Decision dispatches to, on its Message Path, holds its Verdict.
- **Sealing:** the Verdict is sealed at the end of that Run's first Segment. `veto` seals it as vetoed. Reaching the first Suspension Point, or ending without a veto, seals it as allowed.
- **`veto` and `veto reason`** end the Run as `completed`, with result Nothing, and `finally` blocks run. The reason is any value, and a bare `veto` gives Nothing. In a Run that holds no open Verdict, such as one started by a plain `send` or a Host `Deliver`, `veto` just ends the Run, and the Trace records a `note`.
- **`pass`** in a `, deciding` Run hands the open Verdict up the Message Path with the message.
- **Undecided:** a deciding Run that errors, hits a Limit Fault, or is cancelled or stopped before the seal leaves the Decision undecided, with that outcome. A `, dropping` clause that drops a new Decision leaves it undecided, with outcome `dropped`. The Core never guesses allowed or vetoed.
- **Clauses without `, deciding`** allow the Decision at dispatch. If such a Run later passes, the message climbs as an ordinary one.
- **No Fallback:** a Decision never reaches a [Fallback Handler](#the-fallback-handler), anywhere on its path, so a child's Fallback can't allow a Decision before a parent sees it.
- **One Verdict per Decision:** an allow or a veto ends the Decision, so a parent never sees a Decision a child already decided. Reaching the end of the Message Path allows it, and `unhandled` is reported as usual.
- **`, replacing`** on a `, deciding` clause cancels only earlier Runs that are already past their seal.
- **Load errors:**
  - `veto` outside a `, deciding` Handler: in a function, a Lambda, a Library, or a Handler reached by a local call, Command Call or function-style.
  - A `veto` or `pass` in a `, deciding` Handler that some path from the Handler's start reaches through a possible Suspension Point.
  - `, queued` with `, deciding`.
- **Scripts can't start Decisions,** so there is no Script-to-Script veto.
- **Broadcast Decisions** go to every Script that wants the message, and settle once every recipient has sealed. The Verdict is vetoed if any recipient vetoed, undecided if none did but one was undecided, and allowed otherwise, including when there are no recipients. Every veto is reported, in recipient order.

> **Example.**
>
> ```talk
> on beforeMove m, deciding
>   if the to of m is in own then veto "Your own piece is on that square."
>   pass beforeMove
> end beforeMove
> ```

> **Rationale.** A Verdict bounded by one Segment is bounded by the per-Run Fuel limit, so it never waits on a Host answer, a timer or another Script, and needs no deadline of its own ([ADR 0031](../docs/adr/0031-a-decisions-verdict-is-sealed-at-the-end-of-its-first-segment.md)).

## The scheduler

A Group makes progress only inside a Pump ([ADR 0015](../docs/adr/0015-the-host-drives-the-core-through-a-pump.md)). The same Group, with the same Host Inputs, Clock readings, Fuel Slices and limits, interleaves identically and faults at the same instruction on every Core ([ADR 0004](../docs/adr/0004-scripts-are-actors.md), [ADR 0009](../docs/adr/0009-twin-cores-held-to-bit-for-bit-parity.md)).

### A Pump

A Pump does these steps, in order:

1. **Reads the Clock:** it takes its one Clock reading. A reading earlier than the last Pump's is the Host error `clock backwards`.
2. **Drains the input queue** in call order. A Delivery joins the back of its receiver's mailbox, even past its depth, since the depth was checked at the call ([chapter 9](09-embedding.md#deliveries)). An answer or a failure settles its call, which makes the waiting Run ready, unless it waits in a Join with members still pending.
3. **Fires due timers:** every `wait`, `wait for` timeout, `after` branch, `maxPending` and `MaxWait` whose deadline is at or before the reading fires, in deadline order, and of equal deadlines, in the order they were set. Each makes its Run ready.
4. **Runs turns** until no Script has work left, or every Script that has work has spent its Fuel Slice, or the Group's Fuel cap is spent.

The Group is Quiescent when the Pump returns.

### Work and turns

- **A Script's work** is one FIFO queue holding, in the order each became ready, the messages waiting for dispatch and the Runs ready to resume. Mailbox depth counts only the messages in it.
- **Ready:** a Run becomes ready when its `wait` fires, its `wait for` matches or times out, its call is answered, fails or times out, its Join settles or fails, it leaves its clause's queue, or it is cancelled while it isn't running, so that its cleanup runs in a turn ([chapter 6](06-errors-and-limits.md#cancellation-and-stop)).
- **A turn:** Scripts take turns in the order they were loaded into the Group. In its turn, a Script with work takes the head of its queue, dispatches it or resumes it, and runs that Run until it ends, suspends or is preempted. Then the next Script with work takes its turn, round and round.
- **A preempted Run** stays at the head of its Script's queue, and resumes before anything else of that Script, in a later Pump.
- **Messages sent during a Pump** join their receiver's queue at once, so a message sent to a Script can be dispatched in the same Pump.

### Fuel Slices

- **Per Script, per Pump:** a Pump's Fuel Slice counts the Fuel each Script's Runs spend in that Pump, including pending `wait for` test bodies. When a Script's slice is spent, its running Run is preempted before its next instruction, and the Script takes no more turns in that Pump.
- **Observation before dispatch:** when a Script takes a message from its work queue for dispatch, observation checks every pending `wait for` in the order the waits began, and each wait's eligible `when` branches in source order until one matches. Observation finishes before any instruction of the incoming Run, without slice or cap preemption within a test body or between waits. All test Fuel, including failed tests, counts in that Pump, against the receiving Script's slice and the Group cap; its slice overrun becomes that Script's debt. If observation spends the slice or cap, an incoming Run with instructions left to execute is preempted before its first instruction and stays at the head of the work queue, ahead of any Runs observation made ready. Continuing that Run does not observe the message again. An incoming Run needing no instructions still ends as `unhandled`; an internal `error` message with no `on error` clause is still discarded after observation ([chapter 6](06-errors-and-limits.md#uncaught-errors)). A message rerouted to another Script before dispatch is observed and charged only there ([Message Path](#the-message-path)).
- **Debt:** the whole charge of an instruction applies at it ([ADR 0010](../docs/adr/0010-normative-lowering-onto-a-stack-abstract-machine.md)), so a Script can overrun its slice. The overrun is carried to the Script's next Pump as debt, which reduces that Pump's slice. A debt larger than a slice uses the whole slice, and the rest carries on.
- **No slice:** a Fuel Slice of 0 means no slicing. The Run still stops at its Fuel limit.
- **The Group's Fuel cap** counts the Fuel all the Group's Scripts spend in one Pump. When it is spent, the running Run is preempted before its next instruction, and the Pump ends.
- **In the Trace:** every preemption is recorded ([chapter 11](11-the-trace-and-conformance.md)).

### Stop and cancel within a Pump

- **Where they land:** `Stop` and `CancelRun` take effect at the latest at the running Pump's next Host crossing, an Operation or property call, or at its end ([chapter 9](09-embedding.md#threads-and-the-input-queue)). The Trace records where each one landed.
- **Nothing to see:** since a cancelled or stopped Segment leaves no trace in Script state, the step where one lands isn't observable to Scripts ([ADR 0006](../docs/adr/0006-limit-faults-roll-back-the-segment.md)).

## Outside parity

- **Yields:** the TS Core may yield to its event loop in the middle of a Pump. The yield is invisible to Scripts and isn't traced ([ADR 0010](../docs/adr/0010-normative-lowering-onto-a-stack-abstract-machine.md)).
- **Early landing:** a native Core may act on `Stop` or `CancelRun` sooner than the next Host crossing, between instructions. The Trace records where it landed, so a replay follows it.
