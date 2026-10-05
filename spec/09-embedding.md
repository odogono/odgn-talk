# 9. Embedding

_Draws on:_ [ADR 0001](../docs/adr/0001-value-semantics.md), [ADR 0002](../docs/adr/0002-single-decimal-number-type.md), [ADR 0004](../docs/adr/0004-scripts-are-actors.md), [ADR 0005](../docs/adr/0005-durability-is-a-deferred-extension.md), [ADR 0006](../docs/adr/0006-limit-faults-roll-back-the-segment.md), [ADR 0008](../docs/adr/0008-same-core-save-restore.md), [ADR 0009](../docs/adr/0009-twin-cores-held-to-bit-for-bit-parity.md), [ADR 0011](../docs/adr/0011-text-is-nfc-grapheme-clusters-compared-exactly.md), [ADR 0012](../docs/adr/0012-capabilities-are-called-through-tell-and-ask.md), [ADR 0014](../docs/adr/0014-a-session-is-an-ordinary-host.md), [ADR 0015](../docs/adr/0015-the-host-drives-the-core-through-a-pump.md), [ADR 0016](../docs/adr/0016-messages-reach-scripts-through-core-owned-object-parents.md), [ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md), [ADR 0020](../docs/adr/0020-scripts-share-code-through-stateless-libraries.md), [ADR 0025](../docs/adr/0025-lambdas-are-first-class-function-values-that-run-in-their-home-script.md), [ADR 0026](../docs/adr/0026-a-join-starts-several-calls-from-one-run-and-suspends-once.md), [ADR 0028](../docs/adr/0028-tooling-is-one-ts-stack-and-nothing-it-produces-is-normative.md), [ADR 0030](../docs/adr/0030-values-cross-the-host-boundary-as-tagged-values-converted-by-spec-rules.md), [ADR 0031](../docs/adr/0031-a-decisions-verdict-is-sealed-at-the-end-of-its-first-segment.md), [ADR 0038](../docs/adr/0038-settling-a-restored-call-is-a-queued-host-input.md), [ADR 0039](../docs/adr/0039-the-language-name-stands-apart-from-its-publisher.md).

A Host embeds a Core through one interface, declared in [`talk.go`](embedding/talk.go) and [`talk.ts`](embedding/talk.ts). The two files have the same calls, and differ only in idiom: errors as values in Go and exceptions in TS, `Start` and `Answer` in Go and an optional Promise-returning `run` in TS, and maps built from pairs in Go and from a `Map` or `record()` in TS. No Script can observe the differences ([ADR 0015](../docs/adr/0015-the-host-drives-the-core-through-a-pump.md)). They are declarations only, and are never compiled. This chapter states the rules they share, and the language-neutral message layer for a Host in any other language.

## Package names

The Go Core's module path is `github.com/odogono/odgn-talk/impl/go`, with the public package named `northtalk` at the module root ([ADR 0046](../docs/adr/0046-each-core-lives-under-impl-beside-a-shared-spec.md)). The TS Core's package is `@odgn/northtalk` ([ADR 0039](../docs/adr/0039-the-language-name-stands-apart-from-its-publisher.md)).

## The shape

- **`Core`** is process-wide. It holds the compile cache, so a Script or Library with the same code identity compiles once. It defines Capabilities and Object Kinds, compiles Libraries, and makes and restores Groups.
  - **TS helpers:** `createCore()` returns the process-wide Core. The package also keeps its free-function helpers (`defineCapability`, `compileLibrary`, `newGroup`, `restore` and the Capability factories); they use the same process-wide definitions and compile caches. Creating a Core does not reset those definitions or caches. Each Group still owns its live state.
- **`Group`** takes every Host Input: load, add and replace Library, deliver, request, broadcast, decide, call a Function Value, `setParent`, dispose, pump, save and settle. It also gives the Group Fingerprint and an Inspection. Host Objects are made per Group, since parents and disposal belong to it.
- **`Script`** is a handle for calls addressed to one Script: reload, extend, stop, cancel a Run, revoke a Grant, counters, and deliver, request or decide to the Script itself.

## Threads and the input queue

- **Queued calls:** `Deliver`, `Request`, `Broadcast`, `Decide`, `DecideBroadcast`, `Call`, `SetParent`, `Dispose`, `Stop`, `CancelRun`, `Revoke`, `Answer`, `Fail` and `Settle`, and cancelling a `Request`, `Decide` or `Call` through its context or signal. They are safe from any goroutine. Each appends to the Group's input queue, calls `OnReady` and returns at once, with a delivery id where it has one.
- **Draining:** the next Pump takes its Clock reading, then drains the queue in call order and records each input in the Trace there. A Pump never sees an input arrive halfway through.
- **Stop and cancel:** `Stop` and `CancelRun` land at the latest at the running Pump's next Host crossing (an Operation or property call) or at its end. A native Core may act on them sooner, between instructions. Scripts and replay parity can't tell the difference, since the Trace records where each one landed. Everything else waits for the next Pump.
- **Cancelling a Request:** cancelling its context or signal queues `cancel-delivery`. It cancels the Run the Delivery started. A Delivery still in the mailbox is removed instead, and reported as a `run end` with outcome `cancelled` and no run or Handler.
- **Durations:** `MaxPending` and `MaxWait` are whole milliseconds. Go refuses a finer `time.Duration`, and TS a fraction, as `invalid value`.
- **Synchronous errors:** a queued call returns an error only for facts known at the call, such as a full mailbox, a value from another Group, a limit override that loosens, or a settlement for a call that isn't pending. Anything else is known only when the queue is drained, and comes back as a report.
- **Worker calls:** `Load`, `Reload`, `Extend`, `AddLibrary`, `ReplaceLibrary`, `Pump`, `Save`, `Fingerprint`, `Inspect`, `Grants` and `Counters`. They come from the one goroutine that pumps the Group. Two made at once are undefined in Go and not detected.
- **Reentry:** a worker call made from inside the Group's own Pump or a scope/Segment lifecycle callback, including cleanup outside a Pump, is the Host error `reentrant call` in both Cores.
- **Host functions:** Operation functions, property `Get` and `Set`, and Segment lifecycle hooks run inside a Pump. Scope abandonment and Segment rollback can also run during Reload or library replacement. They may make queued calls, subject to the [lifecycle finalization rules](embedding/scoped-effects.md#segment-participant).

## Time and reports

- **The Clock is an argument:** `Pump(now, …)` takes the Group's one Clock reading, and `Call.Now()` returns it. A reading earlier than the last Pump's is `clock backwards`. A game pauses by not pumping, and freezes time by passing the same `now`.
- **Reports are returned, never called back:** a Pump returns its reports as one ordered list, and `Request` and `Call` futures settle as it finishes. Calls that end Runs outside a Pump (`Reload` and `ReplaceLibrary`) return their reports.
- **The report kinds:**
  - `run end`, carrying its delivery id and any broadcast id. An `errored` Run's error reaches the Host as a `ScriptError`: its `code`, its text `message`, and its other fields as its data. Its `at` is the raise that no Unwind Table entry caught, the Run's last `raise` record, and a Limit Fault's is its faulting instruction, the `fault` record's: each gives the code unit, the frame's Handler as an error's `at` names it, the instruction index and the source position. Other outcomes have no `at`
  - `stop`
  - `unhandled`
  - `call failed`, which carries the Host-side detail of a `host error` the Script saw
  - `effect failure`, carrying Script, Run, named Grant, Segment, phase (`abandon`, `begin`, `commit`, `rollback`), status (`failed`, `unknown`), scope for abandonment, and optional Host-only detail; `effect failed` Run reports also identify the failure that prevented commit
  - `decided`, carrying a Decision's Verdict (below)

## Values at the boundary

Each Core gives the Host one opaque, tagged `Value` type. A Host builds values only through named constructors and reads them only through accessors, so every conversion follows a rule this section states ([ADR 0030](../docs/adr/0030-values-cross-the-host-boundary-as-tagged-values-converted-by-spec-rules.md)).

- **Refused, never repaired:** input the value model can't hold is refused at the constructor, as the Host error `invalid value`. Nothing is clamped, rounded or replaced, so a Host bug surfaces at the Host's own call.
- **Numbers in:** `Int`, `Uint`, `FromFloat` and `Dec` in Go, and `num` and `dec` in TS.
  - A float becomes the shortest decimal that reads back as the same float, the digits ECMAScript's `Number::toString` and Go's `strconv.FormatFloat(f, 'g', -1, 64)` both give, so `0.1` stays `0.1`.
  - NaN, ±Infinity, more than 34 significant digits and a magnitude of 10^34 or more are refused ([chapter 3](03-values.md#numbers)). `-0.0` enters as `0`.
  - `Dec` and `dec` read text exactly as `as number` does, one leading `-` included ([chapter 3](03-values.md#reading-numbers)).
- **Numbers out:** a number reads as an opaque `Decimal`. Its `String()` is the canonical text, trailing zeros kept. An integer read fails unless the value is an integer that fits, and the float read rounds to nearest, ties to even.
- **Text:** text that isn't valid UTF-8 (Go), or a lone surrogate (TS), is refused. Text is normalised to NFC when the `Value` is built, uncharged, and text going out is always NFC.
- **Maps:** keys are text. Order is the order the Host gives, and `Entries()` returns insertion order. A duplicate key, compared after NFC, is refused. TS's `record(obj)` refuses integer-like keys, since JS reorders them.
- **The other kinds:**
  - **Nothing** is `northtalk.Nothing` in Go and the `nothing` constant in TS. `null` and `undefined` are never accepted for it.
  - **A Quantity** is built from a `Decimal` and a Unit spelled as a Script spells it (`"kg"`), and reads back as its number and its canonical Unit. An unknown Unit is refused.
  - **A Civil Date** is built from fields, or from text in the `as civil date` syntax, and an invalid date is refused. **An Instant** is built from seconds and nanoseconds since the Unix epoch, or in Go from a `time.Time`, dropping its monotonic reading and zone. No native type is ever read as a Civil Date.
  - **Bytes** are copied in both directions.
  - **A range** is built from two ends as `..` builds one, and reads back as its two ends ([ADR 0034](../docs/adr/0034-numbers-never-have-a-positive-exponent-and-ranges-are-a-value-kind.md)).
  - **A Text Pattern** can only be passed back unchanged. Its canonical source can be read, for display.
  - **A Function Value** is opaque. Its Home Script and display form can be read ([Function Values](#function-values)).
  - **A Host Object** is its own handle type, with the Host's id.
- **The display form:** `String()` and `toString()` give the display form ([chapter 11](11-the-trace-and-conformance.md)).

### JSON and the Value Encoding

- **Plain JSON:** `DecodeJSON` and `EncodeJSON` follow the JSON mapping of [chapter 7](07-libraries-and-the-standard-library.md#the-json-mapping), the rule the `json` Library follows. Numbers are read from their text, never through a float.
- **The Value Encoding** is the lossless JSON form of every kind that can be encoded, for Host storage and the message layer. The same value always gives the same bytes: UTF-8 JSON with no white space, with strings escaped as [the Group Fingerprint's](#the-pump-and-the-group-fingerprint) are, and a JSON number written as its canonical text.
  - Booleans are JSON booleans, text is a JSON string, Nothing is `null`, and a list is an array.
  - A number with no fraction digits in its canonical text (so `3`, but not `3.0`) and a magnitude below 2⁵³ is a JSON number, and every other number is `{"$dec": "<canonical text>"}`. So trailing zeros survive.
  - A map is a JSON object, in order. A map with any key starting with `$` is `{"$map": [[key, value], …]}`, so a key never reads as a tag.
  - The tags are `{"$quantity": ["2.50", "GBP"]}`, with the number's canonical text and the Unit in normal form, every word Unit singular (`["3", "day"]`), `{"$bytes": "<base64, padded>"}`, with the standard alphabet and the bits padding leaves over zero, so decoding refuses any other form, `{"$range": [from, to]}`, `{"$instant": "<RFC 3339 in UTC, with the shortest fraction>"}`, `{"$date": "<the as civil date form>"}`, `{"$pattern": "<canonical source>"}` and `{"$object": [kind, id]}`.
  - A Text Pattern is re-parsed when decoded, and a Host Object is found through the Host's resolver.
  - **Function Values** can't be encoded for storage, since a Host-held handle isn't durable. Only [the message layer](#the-message-layer) carries them.
- **Scripts can't reach** the Value Encoding, and the Conformance Corpus uses the display form instead ([ADR 0018](../docs/adr/0018-the-trace-is-the-corpus-case.md)).

## Shapes

An Operation Declaration gives a Shape for each argument and for its result. Shapes cover every kind, Quantities by Unit or by Unit Kind, lists of a Shape, closed and open maps, Host Objects of a kind, a choice (`OneOf`) and an optional value.

An Object Shape accepts only a Host Object whose Object Kind has the declared name, including a disposed handle. A mismatch writes that Object Kind name as `expected`; `got` remains the value's kind (`"object"` for a Host Object of another Object Kind). Host Objects have no Script literal form, so a literal argument to an Object Shape is refused at load; dynamic values are checked at run time.

`any` accepts every data value, but refuses Function Values, including nested ones, with `not encodable`. `value` accepts every value, including Function Values at any depth. Console's `write` uses `value` so a Script can show any value's text form. Acceptance by a Shape does not make a Function Value durable: the Value Encoding still refuses it.

An Optional Shape accepts either its inner Shape or Nothing. In an Operation's argument list, a suffix of Optional Shapes may also be left off the call. Only an outer Optional wrapper makes a position omittable: a choice containing an Optional Shape still requires its argument, and an Optional Shape before a required one still requires its positional slot. For `[text, Optional(number), Optional(text)]`, a call supplies one, two or three arguments. Too few required positions or too many arguments is `wrong argument count` at load, including calls inside Libraries.

The Host function receives only the arguments supplied, in order. The Core inserts no placeholders or defaults; an explicit Nothing remains a supplied argument. The `call` record and a pending call's arguments keep that same list, including through save, restore, Reissue and Adopt. Only supplied arguments are checked against their Shapes, and the Operation's declared cost is charged for every call regardless of how many Optional positions are omitted. The call instruction's argument count and its Cost Model terms use the supplied count. `say` still requires exactly one source argument, even if a Host grants a custom `console.write` declaration with Optional arguments.

- **At load:** the loader checks each call's argument count, the literal keys of a closed map, and the kind of every literal argument. There is no inference beyond literals.
- **At run time:** the Core checks each argument before the Host function runs. A mismatch raises `wrong kind` in the Script, the Host function never runs, and nothing is charged ([chapter 6](06-errors-and-limits.md#errors-from-capabilities)).
- **Results:** a result that breaks its Shape is the Host's fault. The call ends as `host error`, and the detail goes in a `call failed` report.
- **Messages** have Shapes only in the Host Manifest, for tooling. The Core never checks a Delivery against them.

## Capabilities

- **Defining one:** `DefineCapability` takes a name and its Operations, once per process. Each Operation is a declaration (name, argument and result Shapes, cost, mode, `maxPending`, declared error codes and optional `scope` and `segmentBound` metadata) paired with the Host function that implements it. Declarations are ordered by name, whatever order the Host gives. `ask`, `tell`, `send` and `wait` are refused as Operation names.
- **Modes:**
  - **Immediate:** `Do` runs at the call, inside the Run, and returns the result.
  - **Suspending:** `Start` runs at the call and returns at once, and the Host answers later with `Answer`, `AnswerWithCost` or `Fail`, from any thread.
  - **Fire-and-forget:** `Fire` runs at the call, in order, and its result is dropped. Only these can be called with `tell`.
- **Grants:** a Grant is a set of a Capability's Operations with the Host's own binding data, which each call reads. `Load` binds Grants by the name the Script uses, so one Capability can be granted twice under two names with different bindings. Each Load copies its kept Operation set without changing the reusable Grant template.
- **Grants as used:** with `GrantsAsUsed`, a Script keeps only the granted Operations it and its Libraries use, including unused definitions, Lambda bodies, every imported Library's `needs` and implicit abandonment dependencies; `say` uses `console.write`. This trimming happens once at Load, after validation, and removes names whose kept set is empty. Reload, Extend and Library replacement cannot regain an Operation it discarded.
- **Grant inspection:** the Script's `Grants` returns a fresh map of its kept names to Operation names, including disabled Grants and Grants that are revoked but not yet removed by Reload. Each Operation list is sorted in Unicode code-point order. Map-key enumeration follows the Host language: Go maps have no iteration order, and TS records enumerate integer-like names numerically before other names.
- **Standard Capabilities:** `clock`, `calendar`, `locale`, `timer` and `console` have their declarations fixed by [chapter 7](07-libraries-and-the-standard-library.md#standard-capabilities). Their factories take Host implementations, except for `clock`, and a cost map keyed by Operation name. Every Operation must have its own cost entry, with Fuel required and allocation zero if absent. Both components must be whole numbers from 0 through 9,007,199,254,740,991; a missing or invalid cost is a Host Error `invalid value`. Extra Operation names in the cost map are ignored. The factory copies each declared cost, so later changes to the map or its entries do not change the declaration. A `timer` implementation must supply both `schedule` and `cancel`, and a `console` implementation both `write` and `read`, a `calendar` implementation all six of its methods, and a `locale` implementation all eight; a missing method is also `invalid value`.
- **The call:** a Host function gets a `Call`, which gives the call id, the Script's name, the Grant's binding, the Pump's Clock reading, and a context or signal that is cancelled when the call is abandoned. It never reads the Host's own time.
- **Charging:**
  - The declared cost is charged before the Host function runs, and a Run that can't cover it has a Limit Fault at the call.
  - `Charge` draws more Fuel in proportion to the work, before the work, and only while the Operation is starting. It fails exactly when the Run's Fuel left after the declared cost can't cover it, and the Host function then returns without doing the work.
  - A cost known only later travels with the answer, `AnswerWithCost`, and is charged when the Run resumes, where it can fault.
  - Converting a result into Script values is charged to the Run ([chapter 8](08-the-abstract-machine-and-the-cost-model.md#charging)), and so is converting a `Fail`'s `Data`, as a result is.
- **Failing:** a `Fail`, or a returned `ScriptError`, raises its code in the Script, with its message and its `Data`'s entries as fields ([chapter 6](06-errors-and-limits.md#errors-from-capabilities)). A catalogue code the Operation doesn't declare, a code outside a declared list, or a `Data` key that is reserved, becomes `host error`. So does any other error the Host function returns.
- **Waiting:** a suspending call past its `maxPending`, or else the Script's `MaxWait`, fails with `timeout` and is abandoned. An answer or failure for a call that isn't pending, because it was abandoned, its Run has ended or a restore discarded it, is recorded and ignored.
- **A `Call` belongs to its Group:** its `Answer` and `Fail` reach only the Group that made it, never a Group restored from a save of it. A restored Group is answered through the `Call`s that `Settle` returns, and only the message layer's `answer` and `fail`, which name the Group and the call id, can reach it for a call it no longer holds ([chapter 10](10-save-and-restore.md#variables-only-restore)).
- **Revoking:** `Revoke` takes effect when its queued input is drained. It affects only that Script's named Grant, makes later calls through it raise `capability revoked` until the next Reload, and makes them load errors after it. Calls in flight and their cancellation signals are left to the Host. Repeated revocation and revocation of a name the Script doesn't keep do nothing, but are still recorded. Reload validates with revoked Grants removed, and removes them only if it succeeds; a rejected Reload leaves the old code, kept Grants and revocation state intact. Library replacement applies this same rule at each affected Script's Reload boundary. Extend leaves existing code and Grants intact, but checks the new source against unrevoked Grants.

## Host Objects

- **Object Kinds** are defined once per process, each with its properties. A property has a Shape, a `Get` and optionally a `Set`, each with a cost, and runs inside the Run like an immediate Operation: a value read is checked against the Shape and its conversion charged, and a failure raises as an Operation's does, with `capability` the Object Kind's name and `operation` the property's. A value set that breaks the Shape raises `wrong kind` before the `Set` runs. A property with no `Set` is read-only ([chapter 4](04-expressions-and-statements.md#put-let-and-set)).
- **Handles:** `group.Object(kind, id, native)` makes a handle the first time a Host-owned thing crosses into the Group. The id is the Host's, stable, and unique within its kind in the Group ([ADR 0008](../docs/adr/0008-same-core-save-restore.md)), and a reused one is `duplicate object id`. The Core holds the kind and id, so a Script reads them with `objectKind(o)` and `the id of o` without calling the Host ([chapter 7](07-libraries-and-the-standard-library.md#values)).
- **Parents:** the Core holds each object's parent, and the Host changes it with `SetParent`, queued as a Host Input. A cycle is `parent cycle` ([ADR 0016](../docs/adr/0016-messages-reach-scripts-through-core-owned-object-parents.md), [chapter 5](05-handlers-messages-and-scheduling.md)).
- **Disposing** an object is a queued Host Input. The object stays an ordinary value, with its id and its equality. Sending to it, or reading or setting a property of it, raises `object gone`, and disposing an owner stops its Owning Script within the same Host Input.
- **Well-known objects** are bound to names at load, and an Owning Script to its object.

## Loading and Libraries

- **`Load`** compiles a Script, checks it against its Grants, Libraries and well-known objects, runs its initialiser and adds it to the Group. A rejected Script is a `LoadError`, with its diagnostics ([chapter 2](02-grammar.md#load-time-diagnostics)).
- **Libraries:** `CompileLibrary(src, imports, declarations)` checks Capability calls against explicit Operation modes and argument Shapes, and compiles one once per process, and `AddLibrary` and `ReplaceLibrary` add it to a Group ([chapter 7](07-libraries-and-the-standard-library.md)).
- **Reload and extend** change a loaded Script's code ([chapter 10](10-save-and-restore.md#reload-and-extend)).
- **Stop** ends a Script: its running, parked and suspended Runs are discarded with no `finally`, and messages left in its mailbox are dropped ([chapter 6](06-errors-and-limits.md#cancellation-and-stop)).
- **Limits** are set per Script at load, and some can be tightened per Delivery ([chapter 6](06-errors-and-limits.md#limits)). In Go, a nonzero `LimitOverride` field always overrides; a zero field overrides only when its corresponding bit is marked in `Set` (for example, `Set: OverrideFuelPerRun` with `FuelPerRun: 0`). This preserves omitted numeric fields while allowing an explicit zero budget.

## Capability Scopes and Segment-bound effects

[The lifecycle contract](embedding/scoped-effects.md) specifies declaration validation, Run/Grant ownership, automatic abandonment, participant hooks, failure handling, suspension guards and examples. Its rules apply to every Host interface, including the Message Layer. Lifecycle declarations are normative; executable Core support is separate implementation work.

Ordinary immediate effects remain final. A scope guarantees an abandonment attempt for a still-open resource; it does not undo an explicit close or commit. Segment-bound Operations instead enlist one named Grant and defer its effects until the Segment's outcome is known. No Script syntax is added.

## Deliveries

- **Selectors:** a message name that contains `:` is a Selector: two or more Names, each followed by `:`, whose labels are [Argument Label words](02-grammar.md#argument-label-words) (`move:to:`), with one argument per part. A Delivery, Request, Broadcast or Decision whose name contains `:` but isn't such a Selector, or doesn't have one argument per part, is refused at the call as `invalid value` ([ADR 0055](../docs/adr/0055-handlers-name-their-parameters-with-argument-labels-that-join-the-selector.md)).
- **`Deliver`** routes a message to an object's Owning Script, or the nearest ancestor that has one, and **`Script.Deliver`** addresses a Script directly ([chapter 5](05-handlers-messages-and-scheduling.md)). Each returns a delivery id, which the Run it starts reports.
- **`Request`** is a `send … and wait` from outside. Its future settles with the Run's result, or rejects with `send failed` and the reason. Cancelling its context or signal queues `cancel-delivery`.
- **`Broadcast`** reaches every Script that wants the message when the queue is drained. Each recipient's `run end` carries its own delivery id and the broadcast id.
- **`Call`** calls a Function Value ([Function Values](#function-values)), and **`Decide`** asks for a Verdict ([Decisions](#decisions)).
- **Broadcast limit overrides:** a Broadcast or Broadcast Decision's override is checked at the call against the Core's default limits. Each recipient runs with the tighter of its own limit and the override, so the Broadcast never loosens a recipient's limits, including a Script loaded after the call.
- **Full mailboxes:** a Delivery fails at the call with `MailboxFull`, which is load shedding, not a Host error, when the messages in its receiver's mailbox and the Deliveries already queued to that Script fill its mailbox depth. The receiver is the one the Delivery routes to at the call. A Delivery accepted at the call always joins its mailbox when the queue is drained, even past the depth, since a Broadcast's recipients, a `SetParent` queued ahead of it, or the sends of a running Pump for a call made inside one, aren't known at the call. So a Delivery the Host was told is accepted is never lost.

## The Pump and the Group Fingerprint

- **`Pump(now, options)`** takes the Group's one Clock reading, drains the input queue, fires due waits and runs Runs until nothing is runnable or a Fuel Slice or the Group's Fuel cap is spent ([chapter 5](05-handlers-messages-and-scheduling.md#a-pump)). It returns the Group's state (idle, sliced or stopped), the next deadline, the Fuel used and the reports, and the Group is Quiescent.
- **Code identity:** the SHA-256 of the UTF-8 text made of these lines, each ended by LF: `odgn-talk code identity 1`, the language version, the Cost Model version, `script` or `library`, the unit's name, then the lowercase hexadecimal identity of each Library it imports directly, one per line, each once, in the order of the first `use` line that names it, then a line `source` followed by the source exactly as given. An imported Library's identity covers its own imports, so a unit's identity covers every Library it reaches ([chapter 7](07-libraries-and-the-standard-library.md#registering-identity-and-replacing)). A source that doesn't parse names no imports, and a `use` line that names a Library the Group doesn't hold adds none, so a `load` that fails still has an identity. An extension's identity is in [chapter 10](10-save-and-restore.md#extend-script).
- **The Group Fingerprint** is the SHA-256 of the UTF-8 JSON, with no white space, keys in the order given here, strings escaping only `"`, `\` and U+0000 to U+001F (as `\"`, `\\` and lowercase `\u00xx`), and numbers as JSON integers, of `{"language", "costModel", "libraries", "scripts"}`:
  - `libraries` is each Library the Host added, as `[name, identity]`, ordered by name. The stdlib Libraries aren't listed, since the language version fixes them.
  - `scripts` is each Script's `{"name", "identity", "grants", "limits"}`, ordered by name. `grants` maps each granted name to its Capability's name and its Operation Declarations, in the Host Manifest's data model, ordered by name. A Grant counts whether or not it is revoked or disabled, and one a restore couldn't re-bind counts with its saved Capability and declarations, since revoking is state ([chapter 10](10-save-and-restore.md#restoring)). `limits` maps each limit's `ts` name in [`limits.toml`](data/limits.toml) to the value the Script has after defaults, durations in whole milliseconds, ordered as in `limits.toml`.
  - Each granted name maps to `{"capability", "operations"}`. Operations are ordered by name, with keys `name`, `mode`, `args`, optional `result`, `cost`, optional `maxPending`, optional `errors`, optional `scope`, optional `segmentBound`, in that order. Missing `args` is `[]`; `cost` has `fuel`, then `alloc`, with missing allocation written as `0`. `maxPending` is whole milliseconds and appears only when declared on a suspending Operation. A scope writes `{"opens", "abandon"}` or `{"closes"}` in that key order; `segmentBound` appears only as `true`, with absent and false equivalent. Bindings, Host functions and lifecycle hooks are excluded. Omitted `errors` stays omitted, while an explicit empty catalogue is `[]`, since these accept different failures. Errors are ordered by code, each as `{"code", "fields"}`; missing fields is `[]`, and fields retain declaration order.
  - A scalar Shape is its kind name, or `"any"` or `"value"`. The wrappers are `{"quantity": unit}`, `{"unitKind": kind}`, `{"object": kind}`, `{"list": shape}`, `{"oneOf": [shape, …]}` and `{"optional": shape}`. The `object` wrapper names an Object Kind. A map Shape is `{"map": [field, …]}`, followed by `"open": true` only for an open map. Each field, including an error field, has `key`, `shape`, then `optional: true` only if optional; fields and alternatives retain declaration order. These are the Host Manifest's data model with explicit canonical ordering and defaults.
  - Identities are lowercase hexadecimal. The Fingerprint never covers state, so two Groups in lockstep compare it once, before they start.
- **`Inspect()`** exposes each Script's disabled named Grants in `disabledGrants`, sorted in Unicode code-point order and omitted when empty. It reads the Group without changing it, between Pumps: each Script's Script Variables in declaration order, its Runs that haven't ended, with their status, Handler and what each suspended one waits for, and the messages in its mailbox. A suspended Run's `wait` and `until` are the end reason and deadline its `seg` record wrote, so a call's `maxPending` or `MaxWait` gives no `until`, and its `calls` are the call ids, reply ids or Join Members it still waits for. It charges nothing, and is the Host Input `vars` in the Trace ([chapter 11](11-the-trace-and-conformance.md)). A REPL's `:vars`, `:runs` and `:mailbox` render it ([chapter 12](12-sessions-and-tooling.md)).

## Script counters

`Script.Counters()` is a worker read between Pumps. It returns a fresh snapshot, charges nothing, drains no Host Inputs and changes no scheduling state. It is the Host Input `counters <script>` in the Trace, followed by one `counters` output record ([chapter 11](11-the-trace-and-conformance.md)).

- **`FuelTotal`, `AllocTotal`:** all Fuel and allocation charged to the Script's Runs since load, including live Runs, event Pattern/Guard tests, Capability Charges, Reissue and Script cancellation cleanup. Automatic scope abandonment and Segment lifecycle hooks charge neither Fuel nor allocation. Initialisers at Load, Reload and Extend contribute nothing. A refused Charge contributes nothing. Rollback, Stop, Reload, Library replacement and either restore policy retain already charged work; a live Run's work is counted once when it ends or is discarded.
- **`Runs`:** Runs started since load, including a Run that parks, drops, is unhandled, errors, faults or is cancelled. Each Handler dispatch or Function Value call that starts a Run increments it once; event tests are part of the waiting Run. A Delivery cancelled before dispatch, a stale Function call, a Message Path transfer or an unhandled path with no Owning Script starts no Run. An internal `error` message with no Handler starts no Run either.
- **`Faults`:** Runs that ended with the outcome `limit fault`, once per Run. Ordinary errors, effect failures, Stop and cancellation do not increment it; a Cleanup Budget failure still ends `cancelled`.
- **`PersistentState`:** current logical Persistent State in bytes, with the same accounting as the Script's cap ([chapter 6](06-errors-and-limits.md#limits)). It includes Script Variables, retained Runs and mailbox messages, and falls when work is released.
- **`MailboxLen`:** messages currently in the Script's mailbox. It excludes preempted, ready, suspended and parked Runs and Host Inputs not yet drained. A message's transfer changes the readouts only when a Pump transfers it.

The four lifetime counters carry over Reload, Extend, Library replacement and full or variables-only restore. The two current-state readouts describe the resulting state, rather than preserving the old mailbox or discarded Runs ([chapter 10](10-save-and-restore.md)).

## Function Values

- **What the Host holds:** a Function Value is an ordinary `Value` of kind `function`. The Host can read only its Home Script and its display form, and it can't build one.
- **Bound to its Group:** passing it into another Group is `wrong group`, including inside lists, maps and Function captures. Host message inputs, Call answers/failures and restored settlements refuse these values before accepting them. An immediate or automatically forwarded Promise result, property result or raised Capability failure containing such a value gives `host error`, like an invalid result or failure. This also applies when a restored Operation is reissued. It lives as long as the Host holds it, and nothing needs releasing.
- **Calling it:** `group.Call` has the shape of `Request`. It is a Delivery to the Home Script, recorded in the Trace as a `call-value` Host Input ([chapter 11](11-the-trace-and-conformance.md#host-inputs)).
- **Staleness:** checked when the queue is drained. A stale value rejects with `send failed`, reason `function gone`, and nothing runs.
- **Argument count:** a live Host call starts a Run without a Handler Clause. Before entering its body, the Run checks the Function Value's arity. A mismatch ends it `errored` with `wrong arity` at the body's first instruction, without executing or charging that instruction or unwinding a frame; the function's `catch` and `finally` regions do not apply. The Request rejects with `send failed`, reason `errored`. Defaults and captures are bound in the value's own code unit.
- **Inspection:** a pending Function Value call uses its display form as the mailbox Message's `name`; its Run's `handler` readout uses the same display form. These are inspection labels, not Handler dispatch names.
- **Taking one as an argument:** an Operation that accepts a Function Value declares the `function` Shape, or `value` when it accepts all values. Lists and maps can declare fields or items with these Shapes too.
- **Not durable:** Host storage can't encode it, and a Host-held handle doesn't survive save and restore. Only the message layer carries it, as a reference form (below). A callback that must survive a save should be an ordinary message, as the `timer` Capability's are.

## Decisions

A Decision asks Scripts whether something may happen, such as a game move or a form submit, and gets back a Verdict ([ADR 0031](../docs/adr/0031-a-decisions-verdict-is-sealed-at-the-end-of-its-first-segment.md), #80).

- **The calls:** `group.Decide(ctx, to, m)`, `script.Decide(ctx, m)` and `group.DecideBroadcast(ctx, m)` are queued, like `Request`. They return an id and a `Deciding` future that settles with a `Decided`.
- **The Verdict:** `allowed`, `vetoed` or `undecided`. `Decided` also lists every veto as `{script, run, reason}`, in recipient order, and every undecided recipient as `{script, run, outcome}`.
- **When it settles:** at the end of the first Segment of the first `, deciding` Run that the Decision reaches. The Pump that seals it returns a `decided` report. Usually that is the Pump that drains it. Behind a Fuel Slice or a mailbox backlog it takes more, and a Host that must know now pumps again at the same Clock reading.
- **Undecided** means the deciding Run errored, hit a Limit Fault, ended `effect failed`, was cancelled, dropped or stopped before it sealed. The Core never guesses allow or refuse, so the Host chooses.
- **Deadlines are the Host's:** cancelling the context or signal before the seal queues `cancel-delivery`, and the Decision settles as undecided, `cancelled`. Cancelling after the seal does nothing, so `defer cancel()` is safe.
- **Broadcast:** it settles once every recipient has sealed. It is vetoed if any recipient vetoed, undecided if none did but one was undecided, and allowed otherwise, including when there are no recipients.
- **Reports alongside it:** the deciding Run still gets its own `run end`, often later than the `decided` report, since an allowed Run may go on. A Decision that reaches the end of its Message Path is allowed, and `unhandled` is reported as usual.
- **Not durable:** like `Pending`, the future doesn't survive a restore. The `decided` report still arrives with the same id.

## The message layer

The message layer is the language-neutral form of this interface, for a Host that isn't Go or TS, such as Elixir, over WASI or a sidecar process ([ADR 0030](../docs/adr/0030-values-cross-the-host-boundary-as-tagged-values-converted-by-spec-rules.md), [#79](https://github.com/odogono/odgn-talk/issues/79)). [The message-layer research](../docs/research/message-layer.md) gives the reasons and the measurements.

### Rules

- **One message per call:** each call in `talk.go` is one JSON message with a reply. Values use [the Value Encoding](#json-and-the-value-encoding), and declarations and Shapes use the Host Manifest's data model.
- **The Host starts every exchange:** Host code runs through interim replies: Operations, properties and lifecycle hooks reply to `pump`; scope abandonment and rollback may also reply to `reload` or `replace-library`, and the Host answers it before sending anything else to that Group. The Core never calls the Host, so a WASI build needs no reentrant imports.
- **Received means read:** a queued call sent while a Pump runs may wait in the Host's outbox, and it is received when the Core reads it. Its delivery id is assigned then, and `mailbox full` is decided then.
- **Stops land at a crossing:** `stop` and `cancel-run` land at the latest at the running Pump's next `op` or `prop`, or at its end. The Trace records where.
- **Charging:** each `op` carries the Fuel the Run has left after the declared cost. The Host's `Charge` subtracts from it locally and fails exactly when it would go below 0, and its reply carries the total `charged`.
- **Ids** are the Core's: delivery ids, run ids and call ids are assigned as [chapter 11](11-the-trace-and-conformance.md#ids) says. Handles for Grants, Libraries (by identity), Groups and Scripts (by name), and Host Objects (`[kind, id]`) are the Host's.
- **Host Objects** cross as `{"$object": [kind, id]}`, read against the message's Group. The Host's glue code raises `wrong group` before it sends another Group's object.
- **Function Values** cross as `{"$function": [home, display, token]}`. The token is opaque, and holds the value's own data and its Group, so nothing needs releasing. The Core checks `wrong group` when it reads a token, and `function gone` when the queue is drained. Host storage refuses the tag.
- **Never crossing:** Grant bindings, native objects, `OnReady` and futures stay on the Host's side.

### Messages

A message is `{"m": <name>, "ref": <n>, …fields}`, where `ref` is the Host's integer, which the reply echoes. A reply is `{"ref": n, "ok": {…}}` or `{"ref": n, "err": {…}}`. The error forms are `{"kind": "host error", "code", "detail"}`, `{"kind": "load error", "diagnostics": [{code, message, unit, line, col}]}` and `{"kind": "mailbox full"}`. A reply to `pump`, `restore`, `reload` or `replace-library` may be `{"ref": n, "need": {…}}` instead, which the Host answers with the matching `…-result` message under the same `ref`. Every Group message has a `group` field, and every Script message a `script` field too. (V) marks a field in the Value Encoding.

| Message | Fields | Reply | `talk.go` |
| --- | --- | --- | --- |
| `hello` | `protocol` | `language`, `costModel`, `unicode`, `core`, `saveFormat` | `CoreVersions` |
| `define-capability` | `name`, `ops`: Operation Declarations, optional `segmentLifecycle: true` advertising all three hooks | – | `DefineCapability` |
| `standard-capability` | `name`, `costs` | – | `ClockCapability` and the others |
| `define-object-kind` | `name`, `props`: `[{name, shape, readOnly, getCost, setCost}]`, `parentKinds` | – | `DefineObjectKind` |
| `grant` | `capability`, `ops`: names, or `"all"` | `grant`: a handle | `Grant`, `GrantAll` |
| `compile-library` | `name`, `version`, `source`, `imports`: identities, `declarations`: Operation modes and argument Shapes | `identity`, `needs` | `CompileLibrary` |
| `new-group` | `name`, `trace`: a boolean | – | `NewGroup` |
| `load` | `name`, `source`, `grants`: `{name: handle}`, `grantsAsUsed`, `owner`, `objects`, `limits` | `script`, `trace` | `Load` |
| `add-library`, `replace-library` | `identity`, and `carry` for a replace | –, or `reports` | `AddLibrary`, `ReplaceLibrary` |
| `object` | `kind`, `id` | – | `Object` |
| `set-parent`, `dispose` | `object`, and `parent` | – | `SetParent`, `Dispose` |
| `deliver`, `request` | `to`: `{object}` or `{script}`, `message`: `{name, args (V), limits}` | `delivery` | `Deliver`, `Request` |
| `cancel-delivery` | `delivery` | – | cancelling a `Request`, `Decide` or `Call` |
| `broadcast` | `message` | `broadcast` | `Broadcast` |
| `call` | `fn (V)`, `args (V)`, `limits` | `delivery` | `Call` |
| `decide` | `to`, `message`, or `broadcast: true` and `message` for a Broadcast Decision | `delivery`, or `broadcast` | `Decide`, `DecideBroadcast` |
| `answer` | `call`, `value (V)`, and optionally `fuel` | – | `Answer`, `AnswerWithCost` |
| `fail` | `call`, `error`: `{code, message, data (V)}` | – | `Fail` |
| `pump` | `now`, `fuelSlice`, `fuelCap` | `state`, `nextDeadline`, `fuelUsed`, `reports`, `abandoned`, `trace` | `Pump` |
| `op` (interim) | `call`, `script`, `run`, `segment`, `grant`, `capability`, `operation`, `mode`, `now`, `args (V)`, optional `scope`, `automatic`, and `fuelLeft` for Script calls only | `op-result`: `{result (V)}`, `{started}`, `{done}`, `{fail}`, `{limit}` or `{hostError}`, each with `charged` | `Do`, `Start`, `Fire` |
| `effect` (interim) | `script`, `run`, `segment`, `grant`, `phase`: `begin`, `commit` or `rollback`, `now` | `effect-result`: `{status: "ok" \| "failed" \| "unknown", detail?}` | Segment lifecycle hooks |
| `prop` (interim) | `object`, `prop`, and `value (V)` for a set | `prop-result`: `{value (V)}`, `{ok}`, `{fail}` or `{hostError}` | `Get`, `Set` |
| `save`, `fingerprint` | – | `save`, `fingerprint`: bytes | `Save`, `Fingerprint` |
| `inspect` | – | `scripts`: `[{name, disabledGrants?, vars: [[name, value (V)]], runs: [{id, status, handler, wait, until, calls}], mailbox: [{delivery, from, message}]}]` | `Inspect` |
| `restore` | `name`, `save`, `libraries`: identities, `mismatch`, `trace` | `variablesOnly`, `pending`: `[{call, script, grant, operation, args (V)}]`, `disposed`: `[[kind, id]]`, `discardedRuns`, `droppedMessages`, `abandonedCalls` | `Restore` |
| `resolve` (interim) | `grants`: `[[script, name]]`, `objects`: `[[kind, id]]` | `resolve-result`: `grants`: handles or `null`, `objects`: booleans | `Grants`, `Resolve` |
| `settle` | `call`, `settlement`: `{answer (V)}`, `{fail}`, `{reissue}` or `{adopt}` | – | `Settle`; an adopted call is answered with `answer` or `fail` |
| `reload`, `extend` | `source`, and `carry` for a reload | `reports`, or – | `Reload`, `Extend` |
| `stop`, `cancel-run`, `revoke` | `reason`, `run`, or `grant`: the name | – | `Stop`, `CancelRun`, `Revoke` |
| `counters`, `grants` | – | `Counters`, or `{name: [ops]}` | `Counters`, `Grants` |
| `export-manifest` | the manifest's definitions, by handle | `manifest`: bytes | `ExportManifest` |

- **Reports** are `talk.ts`'s `Report` union as data: `run end` (`script`, `run`, `delivery`, `broadcast`, `handler`, `outcome`, `result (V)`, `error`, `limit`, `effect`, `at`, `fuel`, `alloc`), `stop`, `unhandled`, `call failed`, `effect failure` and `decided`.
- **Encodings:** `now` and `nextDeadline` are `$instant` text, byte strings (saves, identities, fingerprints) are `{"$bytes": …}`, durations are whole milliseconds, and every other integer is a JSON integer when its magnitude is below 2⁵³, and its decimal text in a JSON string otherwise.
- **Traces:** when a Group was made with `trace: true`, the reply to every message that is a Host Input recorded in the Trace carries `trace`, the records it made ([chapter 11](11-the-trace-and-conformance.md)).
- **Framing:** over WASI, the Host writes a frame into a buffer the export `talk_buffer(n)` gives, and `talk_send(n)` returns the reply's pointer and length packed as `ptr << 32 | len`. A sidecar sends each frame as a 4-byte big-endian length, then the JSON, both ways on stdio.

Automatic `op` requests have `automatic: true`, no `fuelLeft`, and a zero `charged` reply. They take `args: []` and use the ordinary immediate `op-result`; an invalid result is a failed abandonment. Script requests have `automatic: false`. The Core applies acquisition/closure acknowledgements before processing result conversion or queued interruption. Lifecycle `effect-result` replies carry no Script values or charges. The enclosing worker call returns final reports only after all its interim exchanges complete. A malformed lifecycle reply is `unknown`, not an ordinary Script error.

## Host error catalogue

Host misuse is refused at the call that made it, as a `HostError` with one of these codes. Parity covers the code, not the detail text.

<!-- generated: host-errors -->

| Code | Raised when |
| --- | --- |
| `clock backwards` | A Pump, or the first Pump after a restore, reads a Clock earlier than the last one |
| `parent cycle` | `setParent` would make a cycle |
| `duplicate object id` | A Host Object id is reused within its kind in one Group |
| `name reused` | extend Script reuses a name, or a Library name is added twice |
| `reentrant call` | A worker call is made from inside the Group's own Pump or a scope/Segment lifecycle callback |
| `wrong group` | A Function Value or Host Object is passed into a Group it doesn't belong to |
| `library mismatch` | A Library's imports aren't in the Group, or have different identities there |
| `reserved name` | A Host registers a Library under a stdlib name |
| `not adoptable` | A TS `run` call is settled by adopt after a restore |
| `invalid value` | Input the value model can't hold ([ADR 0030](../docs/adr/0030-values-cross-the-host-boundary-as-tagged-values-converted-by-spec-rules.md)), a malformed declaration, a message name with a `:` that isn't a Selector with one argument per part ([ADR 0055](../docs/adr/0055-handlers-name-their-parameters-with-argument-labels-that-join-the-selector.md)), or a limit override that loosens |
| `invalid save` | `Restore` is given bytes this Core can't read: another Core family's save, a save format it no longer reads, or corrupt bytes |
| `save mismatch` | A save's versions, Libraries or Grants don't match, and the Host's policy is to reject |
| `unknown call` | `Settle` names a call id that isn't pending or one already settled, or is made once the first Pump has started |
| `state too large` | The state an extension adds, or the Script Variables a Reload or a variables-only restore carries over, would exceed the Persistent State cap |
| `effects pending` | Save is attempted while a Capability Scope or Segment participant is live, or after fatal effect uncertainty stopped the Group |
| `effect state unknown` | Load, Reload, Extend or ReplaceLibrary attempts to change a Group stopped by fatal effect uncertainty |

<!-- end -->

A `LoadError` carries load-time diagnostics instead, and `MailboxFull` is load shedding, not a bug.

## The Host Manifest format

- **The file:** `ExportManifest` writes one JSON file per kind of Script, named `<kind>.talk-manifest.json`. The same definitions always give the same bytes.
- **Its fields:** `kind`, `version` and `language`, then these arrays:
  - `grants`: name, Capability, and Operation Declarations
  - `libraries`: name, version, source and `needs`
  - `messages`: name (a Selector for a labelled message), argument Shapes and receiving kinds
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
6. An Operation name may be a keyword elsewhere (`put`, `delete`, [ADR 0012](../docs/adr/0012-capabilities-are-called-through-tell-and-ask.md)) or a stdlib name. Operation names are their own namespace, so `locale`'s `upper` doesn't clash with the `upper` Built-in ([ADR 0024](../docs/adr/0024-locale-data-comes-from-a-standard-capability.md)).

`DefineCapability` refuses `ask`, `tell`, `send` and `wait` as Operation names, since they read badly on every Host. The rest of the guide is advice.

## Host conventions

Non-normative ([ADR 0030](../docs/adr/0030-values-cross-the-host-boundary-as-tagged-values-converted-by-spec-rules.md)): HTTP header names are lowercase. A repeated header's values are joined with `, `, except `set-cookie`, which is a list of text.

## Outside parity

- **Idiom:** how each Core expresses the interface: errors or exceptions, `Start`/`Answer` or a Promise, and the builders for maps.
- **Wording:** a `HostError`'s detail, and a diagnostic's message. Their codes are normative.
- **Helpers** built only on this interface, versioned with each Core: the drivers (`github.com/odogono/odgn-talk/impl/go/driver` in Go, with a worker pool, a run queue and a timer per Group, and `autoDrive(group)` from `@odgn/northtalk/driver` in TS), the `Must*` value constructors, Trace file sinks and the corpus runner. Game Hosts pump by hand.
- **The TS Core's debug-pause hook** ([ADR 0028](../docs/adr/0028-tooling-is-one-ts-stack-and-nothing-it-produces-is-normative.md), [Appendix C](appendix-c-handed-off-open.md)).
- **The message layer's framing, and protocol errors** (an unknown message, a malformed frame or an unexpected `ref`), which are the transport's. Its messages, fields and encodings are normative.
- **The Host Manifest** is for tooling, and the Core never reads it.
- **Host conventions** such as lowercase HTTP header names.
