# 6. Errors and limits

_Draws on:_ [ADR 0006](../docs/adr/0006-limit-faults-roll-back-the-segment.md), [ADR 0010](../docs/adr/0010-normative-lowering-onto-a-stack-abstract-machine.md), [ADR 0015](../docs/adr/0015-the-host-drives-the-core-through-a-pump.md), [ADR 0016](../docs/adr/0016-messages-reach-scripts-through-core-owned-object-parents.md), [ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md), [ADR 0020](../docs/adr/0020-scripts-share-code-through-stateless-libraries.md), [ADR 0025](../docs/adr/0025-lambdas-are-first-class-function-values-that-run-in-their-home-script.md), [ADR 0026](../docs/adr/0026-a-join-starts-several-calls-from-one-run-and-suspends-once.md), [ADR 0030](../docs/adr/0030-values-cross-the-host-boundary-as-tagged-values-converted-by-spec-rules.md), [ADR 0031](../docs/adr/0031-a-decisions-verdict-is-sealed-at-the-end-of-its-first-segment.md), [ADR 0033](../docs/adr/0033-the-error-catalogue-settles-its-fields-and-codes.md).

A Run can end badly in three ways, and they don't mix. An Error is an ordinary value that a Script raises, catches and rethrows. A Limit Fault is the end of a Run that exceeded a resource limit, and no Script code sees it. Cancellation and Stop Script come from outside the Run. This chapter states the rules for each, the error-code catalogue and the limits. Host misuse of the embedding interface is a Host Error, in [chapter 9](09-embedding.md#host-error-catalogue), and never reaches a Script.

## Errors

- **An Error is a plain map** with a text `code` ([ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md)). It follows Value Semantics, like any map, and needs no value kind of its own.
- **Codes** are lowercase words separated by spaces, such as `"capability revoked"`. Every code the Core raises is in [the catalogue](#the-error-code-catalogue). The codes a Script throws are free-form.
- **A Core-raised error** carries `code`, `message`, `at` and the fields its catalogue entry lists. Parity covers the code and every field exactly, but not the wording of `message`.
- **`at`** is the source position of the raise, added by the Core only when the map has no `at` key, so a rethrow keeps the original position. It is the map `{unit, handler, line, column}`:
  - `unit` is the name of the Script or Library whose code raised it.
  - `handler` is the name of the Handler or function the code is in, the enclosing one for a Lambda.
  - `line` and `column` are the position, counted as in [chapter 1](01-lexical-structure.md#source-text), that the source map gives the raising instruction ([chapter 8](08-the-abstract-machine-and-the-cost-model.md)).
- **Input positions** are other fields. `offset` is a 1-based Character position in text, and `path` is a list of keys and 1-based indices into a value ([ADR 0033](../docs/adr/0033-the-error-catalogue-settles-its-fields-and-codes.md)).
- **Kind names** in fields such as `expected` and `got` are the kind names of [chapter 3](03-values.md).
- **Not Errors:** a Limit Fault, a cancellation and Stop Script are not Errors. No `catch` sees them.

## Raising

- **`throw e`** raises the map `e` as it is, adding `at` if it is missing. The map needs a text `code`, and `message` is optional.
- **`throw t`**, for a text `t`, raises `{code: t}`, decided at run time by the value's kind.
- **Anything else** given to `throw` raises `bad throw`.
- **Built-ins, operators and statements** raise catalogue codes, such as `can't convert` for `"lots" as number`.
- **Unwinding** walks the Run's frames, including calls to the Script's own Handlers and to Library code, each through its own Unwind Table ([chapter 8](08-the-abstract-machine-and-the-cost-model.md)). It is charged per frame popped. A Run that can't pay for its unwinding has a Limit Fault at the `throw`.
- **The Trace** records every raise, caught or not, as its code and instruction ([chapter 11](11-the-trace-and-conformance.md)).

## Catching

- **`try … end try`** runs its block. An error raised in it, or in anything it calls, is matched against its `catch` clauses.
- **Clauses are Destructuring heads** with optional Guards, tried top to bottom, like Handler Clauses. The first that matches runs, with its names bound. A bare `catch e` matches every error.
- **Shorthand:** `catch "out of stock"` is short for `catch {code: "out of stock"}`, and a `where` Guard may follow it. Only a text literal is shorthand, so a name in a head still binds.
- **No match:** if no clause matches, the error keeps unwinding, after the `try`'s `finally` runs.
- **Guards** on `catch` clauses follow the rules for Handler Guards. An error in one skips the clause and is invisible, except in the Trace.
- **An error in a `catch` body** unwinds from there, through the `try`'s `finally`.
- **Nothing rolls back:** a caught error undoes no write to a Script Variable. Rollback is only for Limit Faults and cancellation, where the Script can't react ([ADR 0006](../docs/adr/0006-limit-faults-roll-back-the-segment.md)).
- **What `catch` never sees:** a Limit Fault, a cancellation or Stop Script. So a `catch e` in a loop can't soak up any of them.

> **Example.**
>
> ```talk
> try
>   ask http to get url and wait
> catch {code: "http", status: s} where s >= 500
>   tell log to write "server error " & s
> catch "timeout"
>   tell log to write "no answer"
> end try
> ```

### `finally`

- **A clause of `try`:** `finally` comes after the `catch` clauses. It runs when the `try` completes, and when an error leaves it, whether caught or not. It also runs when `return`, `exit repeat` or `next repeat` leaves the `try`.
- **On a Handler:** a Handler whose body ends in `finally` is short for a `try` around its whole body.
- **No Suspension Points:** a `finally` block may contain no possible Suspension Point. The loader checks this.
- **On the Run's budgets:** on completion and on errors, `finally` runs on the Run's own Fuel and limits.
- **An error in `finally`** replaces the error in flight, if there is one. The old error goes in the new map's `during` field, added only when it is missing.
- **On cancellation,** `finally` blocks run on the Cleanup Budget ([below](#cancellation-and-stop)).
- **Never** on a Limit Fault or Stop Script.

## Uncaught errors

- **The Run ends `errored`.** Its `run end` report carries the error map as a Host value.
- **The `error` message:** the Core then puts an ordinary `error` message, with the error map as its one argument, at the back of the Script's own mailbox. An `on error` Handler picks it up as a new Run, so it never runs inside the failed Run and can't resume it.
- **Clauses:** `on error` can have Handler Clauses, as any Handler can, such as `on error {code: "timeout"}`. `on error "timeout"` is short for that, as in `catch`.
- **`, during name`** binds `name` to the message the failed Run was handling, as the map `{name, args}`. The suffix is allowed only on `on error`.
- **Only for `errored`:** there is no `error` message for a Limit Fault, `cancelled`, `unhandled` or `dropped`.
- **No chain:** a Run started by an `error` message that errors itself sends no further `error` message.
- **Nowhere to go:** an `error` message that no clause matches, including when the Script has no `on error`, is dropped. It never climbs the Message Path and isn't reported as `unhandled`. If the mailbox is full, the message is dropped, and the Trace records a `note`.

> **Example.**
>
> ```talk
> on error {code: c, message: m}, during msg
>   tell log to write "a Run failed: " & c & ": " & m
> end error
> ```

## Errors from Capabilities

- **`Fail`:** a Host function that fails with a `ScriptError` raises its code as is. Its `message` becomes `message`, and the entries of its `Data` become top-level fields, converted and charged to the calling Run. The Core adds `capability`, `operation` and `at`.
- **Becomes `host error`,** with only `capability` and `operation`:
  - a `Fail` with a catalogue code, unless it is a Standard Capability code its Operation declares (below)
  - a `Fail` whose `Data` uses a reserved key, listed in [the catalogue](#the-error-code-catalogue)
  - a `Fail` with a code outside its Operation's declared list, when the Operation lists its codes
  - a Host function that fails with anything else, such as a Go panic or a TS exception
  - a result that breaks its Operation's result Shape ([ADR 0030](../docs/adr/0030-values-cross-the-host-boundary-as-tagged-values-converted-by-spec-rules.md))
- **No Host detail:** a `host error` carries nothing from the Host, since a panic's text could leak Host internals. The detail goes only in the `call failed` report. Uncaught, a `host error` ends the Run as `errored`, like any other error.
- **Standard Capability codes:** the fixed `calendar` Operation Declarations list `unknown zone` and `ambiguous time`, and a Host may `Fail` with them. The Core checks their fields against the catalogue, and a mismatch becomes `host error`. The Core checks a `locale` tag itself before the Host function runs, and raises `bad locale` ([ADR 0033](../docs/adr/0033-the-error-catalogue-settles-its-fields-and-codes.md)).
- **Arguments are checked first:** an argument that breaks its Shape raises `wrong kind` before the Host function runs, and nothing is charged. The fields describe the first node that doesn't match, searched depth-first in argument order: `argument` is its 1-based position and `path` locates it inside the argument, when it isn't the argument itself. A `OneOf` expects its kind names joined with `" or "`. For a missing key, `got` is `"nothing"`, and for an extra key in a closed map, `expected` is `"nothing"`. A data-Shaped argument holding a value plain data can't hold raises `not encodable`.
- **Revoked Grants:** a call through a revoked Grant raises `capability revoked` until the next Reload, after which it is a load error.
- **Charging:** a `Charge` the Run can't cover is a Limit Fault at the call, not an Error.

## Errors across Scripts

- **`send failed`:** when the receiver of a `send … and wait` doesn't reply, the sender raises `{code: "send failed", reason}` at the `send`. `reason` is `errored`, `limit fault`, `cancelled`, `unhandled`, `dropped` or `stopped`, and for `errored`, `error` is the receiver's error map. Uncaught, it ends the sender's Run as `errored` too.
- **The receiver** still reports its own outcome, and for `errored` its own `on error` still fires.
- **From the Host:** a `Request` rejects with the same map, as a rejected Promise in TS and an error value in Go. A Host `Call` of a stale Function Value rejects with reason `function gone`, and nothing runs.
- **Function Values:** a call to a Function Value in another Script fails as `send … and wait` does. A stale Function Value called from inside a Script raises `function gone` itself.
- **Plain calls:** a Command Call to a Handler of the Script, or an imported one, is a plain call, so its errors unwind straight into the caller.
- **`timeout`:** a `send … and wait` or a Function Value call that runs past `MaxWait` raises `timeout`, with `after`, and the receiver keeps running.

### Joins

- **Fail fast:** the first Join Member failure to arrive resumes the Run and is raised at `end wait`, as the member's own error map plus `index`, its 1-based start position. A failed send member raises `send failed`, plus `index`.
- **`index`** is added only when it is missing, so a rethrow keeps it. It is a reserved key.
- **The rest** of the pending members are abandoned ([chapter 5](05-handlers-messages-and-scheduling.md#joins)).

> **Example.**
>
> ```talk
> try
>   wait for all
>     repeat for each s in stations
>       ask weather to fetch s and wait
>     end repeat
>   end wait
> catch {code: "timeout", index: i}
>   tell log to write "station " & i & " timed out"
> end try
> ```

## The error-code catalogue

[`errors.toml`](data/errors.toml) lists every code the Core raises inside a Script. Each code has one set of fields that every raise carries, and a raise that knows more adds the optional fields beside them ([ADR 0033](../docs/adr/0033-the-error-catalogue-settles-its-fields-and-codes.md)). Every field has one meaning wherever it appears.

<!-- generated: errors -->

**Reserved keys:** `code`, `message`, `at`, `capability`, `operation`, `index`, `during`. The Core sets them, and a Host `Fail`'s `Data` may not use them.

| Code | Fields | Raised when | Sources |
| --- | --- | --- | --- |
| `bad throw` | none | `throw` is given something that isn't a map with a text `code`, or text | [ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md), [#61](https://github.com/odogono/odgn-talk/issues/61) |
| `no match` | none | A Destructuring test fails in `let` or in a Lambda's parameters, or a binary text decode fails | [ADR 0010](../docs/adr/0010-normative-lowering-onto-a-stack-abstract-machine.md), [ADR 0013](../docs/adr/0013-binary-patterns-are-sequential-destructuring.md), [ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md), [ADR 0025](../docs/adr/0025-lambdas-are-first-class-function-values-that-run-in-their-home-script.md) |
| `send failed` | `reason`; optional: `error` | The receiver of a `send … and wait`, a Function Value call or a Host `Request` doesn't answer; `reason` is `errored`, `limit fault`, `cancelled`, `unhandled`, `dropped`, `stopped` or `function gone`, and `error` is present only for `errored` | [ADR 0015](../docs/adr/0015-the-host-drives-the-core-through-a-pump.md), [ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md), [ADR 0025](../docs/adr/0025-lambdas-are-first-class-function-values-that-run-in-their-home-script.md), [ADR 0026](../docs/adr/0026-a-join-starts-several-calls-from-one-run-and-suspends-once.md), [ADR 0031](../docs/adr/0031-a-decisions-verdict-is-sealed-at-the-end-of-its-first-segment.md), [ADR 0033](../docs/adr/0033-the-error-catalogue-settles-its-fields-and-codes.md) |
| `mailbox full` | `to` | A `send` finds the receiver's mailbox full; it is raised at the `send`, even one that doesn't wait | [ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md), [ADR 0026](../docs/adr/0026-a-join-starts-several-calls-from-one-run-and-suspends-once.md) |
| `capability revoked` | `capability`, `operation` | A call goes through a revoked Grant | [ADR 0015](../docs/adr/0015-the-host-drives-the-core-through-a-pump.md), [ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md) |
| `wrong kind` | `expected`, `got`, `value`; optional: `capability`, `operation`, `argument`, `path` | An operand or argument has the wrong kind, e.g. `"007" + 1`, `if 0` or a Text Pattern search on a value that isn't text; for a Capability argument that breaks its Shape, the fields describe the first node that doesn't match, `argument` is its 1-based position and `path` locates the node inside it | [ADR 0003](../docs/adr/0003-no-implicit-coercion.md), [ADR 0015](../docs/adr/0015-the-host-drives-the-core-through-a-pump.md), [ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md), [ADR 0023](../docs/adr/0023-named-time-zones-come-from-a-standard-capability.md), [ADR 0024](../docs/adr/0024-locale-data-comes-from-a-standard-capability.md), [ADR 0030](../docs/adr/0030-values-cross-the-host-boundary-as-tagged-values-converted-by-spec-rules.md), [ADR 0033](../docs/adr/0033-the-error-catalogue-settles-its-fields-and-codes.md) |
| `can't convert` | `value`, `to`; optional: `format`, `offset` | A conversion fails, e.g. `"lots" as number` or a bad `as` target, a parse such as `parseDate` doesn't match, or a spliced Text Pattern clashes with the one it is spliced into; a parse adds `offset`, and `parseDate` adds its template as `format` | [ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md), [ADR 0021](../docs/adr/0021-the-stdlib-is-a-small-built-in-core-plus-libraries-written-in-the-language.md), [ADR 0022](../docs/adr/0022-compound-units-convert-into-the-left-operands-units.md), [ADR 0023](../docs/adr/0023-named-time-zones-come-from-a-standard-capability.md), [ADR 0024](../docs/adr/0024-locale-data-comes-from-a-standard-capability.md), [ADR 0033](../docs/adr/0033-the-error-catalogue-settles-its-fields-and-codes.md), [#89](https://github.com/odogono/odgn-talk/issues/89) |
| `can't compare` | `left`, `right` | `<` or a sort orders two values of kinds that can't be compared, e.g. a text and a number, or a date-only value and a date-time; the fields are the two operands | [ADR 0003](../docs/adr/0003-no-implicit-coercion.md), [ADR 0023](../docs/adr/0023-named-time-zones-come-from-a-standard-capability.md), [ADR 0033](../docs/adr/0033-the-error-catalogue-settles-its-fields-and-codes.md) |
| `division by zero` | none | A number is divided by zero | [ADR 0002](../docs/adr/0002-single-decimal-number-type.md), [ADR 0033](../docs/adr/0033-the-error-catalogue-settles-its-fields-and-codes.md) |
| `overflow` | `operator` | An arithmetic result is 10^34 or more in magnitude; `operator` is the operator or function, e.g. `"*"` or `"exp"` | [ADR 0002](../docs/adr/0002-single-decimal-number-type.md), [ADR 0033](../docs/adr/0033-the-error-catalogue-settles-its-fields-and-codes.md), [ADR 0034](../docs/adr/0034-numbers-never-have-a-positive-exponent-and-ranges-are-a-value-kind.md) |
| `incompatible units` | `left`, `right` | An operation combines Quantities of different dimensions or Unit Kinds, e.g. `1 month + 1 day` or a range from `1 m` to `2 kg`, adds a calendar duration to an Instant, or adds to a date-only value an exact duration that isn't a whole number of days, or to a Civil Date a calendar duration that isn't a whole number of months; the fields are the two Units' display forms | [ADR 0022](../docs/adr/0022-compound-units-convert-into-the-left-operands-units.md), [ADR 0023](../docs/adr/0023-named-time-zones-come-from-a-standard-capability.md), [ADR 0033](../docs/adr/0033-the-error-catalogue-settles-its-fields-and-codes.md), [ADR 0034](../docs/adr/0034-numbers-never-have-a-positive-exponent-and-ranges-are-a-value-kind.md), [#89](https://github.com/odogono/odgn-talk/issues/89) |
| `host error` | `capability`, `operation` | A Host function fails with something other than a Script error, a `Fail` misuses a reserved code or key or uses a code its Operation doesn't declare, or a result breaks its Shape; it carries no Host detail | [ADR 0015](../docs/adr/0015-the-host-drives-the-core-through-a-pump.md), [ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md), [ADR 0030](../docs/adr/0030-values-cross-the-host-boundary-as-tagged-values-converted-by-spec-rules.md), [ADR 0033](../docs/adr/0033-the-error-catalogue-settles-its-fields-and-codes.md) |
| `timeout` | `after`; optional: `capability`, `operation` | A suspending Operation call runs past its `maxPending` or the Script's `MaxWait`, or a `send … and wait` or a call to a Function Value in another Script runs past `MaxWait`, and is abandoned; `after` is the limit that ran out, in `ms`, and a Capability call adds `capability` and `operation` | [ADR 0015](../docs/adr/0015-the-host-drives-the-core-through-a-pump.md), [ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md), [ADR 0026](../docs/adr/0026-a-join-starts-several-calls-from-one-run-and-suspends-once.md) |
| `would suspend` | none | A Function Value that may suspend is called without `and wait`, or handed to a Library function such as `map` | [ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md), [ADR 0020](../docs/adr/0020-scripts-share-code-through-stateless-libraries.md), [ADR 0025](../docs/adr/0025-lambdas-are-first-class-function-values-that-run-in-their-home-script.md) |
| `function gone` | none | A stale Function Value is called, after a variables-only restore or a Library replace | [ADR 0008](../docs/adr/0008-same-core-save-restore.md), [ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md), [ADR 0025](../docs/adr/0025-lambdas-are-first-class-function-values-that-run-in-their-home-script.md) |
| `wrong arity` | none | A Function Value is called with too few or too many arguments: a Lambda's count, or outside a named function's range from its required parameters to all of them | [ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md), [ADR 0025](../docs/adr/0025-lambdas-are-first-class-function-values-that-run-in-their-home-script.md), [ADR 0035](../docs/adr/0035-trailing-function-parameters-may-have-constant-defaults.md) |
| `not encodable` | `kind`, `path` | JSON encoding, or a data-Shaped Capability argument, meets a value plain data can't hold, such as a Quantity or Bytes; `path` locates it inside the value being encoded | [ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md), [ADR 0021](../docs/adr/0021-the-stdlib-is-a-small-built-in-core-plus-libraries-written-in-the-language.md), [ADR 0025](../docs/adr/0025-lambdas-are-first-class-function-values-that-run-in-their-home-script.md), [ADR 0033](../docs/adr/0033-the-error-catalogue-settles-its-fields-and-codes.md) |
| `out of domain` | `function`, `value` | An argument is outside a function's domain, e.g. `sqrt(-1)`, a `format` key that's missing, a bad sort direction, or a Standard Capability option word that isn't listed; `value` is the argument, the missing key or the word, and `function` is the function's or Operation's name | [ADR 0002](../docs/adr/0002-single-decimal-number-type.md), [ADR 0021](../docs/adr/0021-the-stdlib-is-a-small-built-in-core-plus-libraries-written-in-the-language.md), [ADR 0025](../docs/adr/0025-lambdas-are-first-class-function-values-that-run-in-their-home-script.md), [ADR 0033](../docs/adr/0033-the-error-catalogue-settles-its-fields-and-codes.md) |
| `out of range` | `field`, `value` | A value is outside the range its position allows: a date outside 0001–9999, a date field that isn't an in-range integer, a `character`, `word` or `byte` write past the end, any chunk write at index 0, before the start or over a reversed range, a negative `repeat` count, an empty `delimited by`, or a Binary Pattern build value too large for its segment | [ADR 0011](../docs/adr/0011-text-is-nfc-grapheme-clusters-compared-exactly.md), [ADR 0013](../docs/adr/0013-binary-patterns-are-sequential-destructuring.md), [ADR 0023](../docs/adr/0023-named-time-zones-come-from-a-standard-capability.md), [ADR 0033](../docs/adr/0033-the-error-catalogue-settles-its-fields-and-codes.md), [#89](https://github.com/odogono/odgn-talk/issues/89) |
| `can't decode` | `format`, `offset` | `decodeJson` is given invalid JSON | [ADR 0021](../docs/adr/0021-the-stdlib-is-a-small-built-in-core-plus-libraries-written-in-the-language.md), [ADR 0033](../docs/adr/0033-the-error-catalogue-settles-its-fields-and-codes.md) |
| `unknown zone` | `zone` | A `calendar` Operation is given an unknown IANA zone; the Host fails with it | [ADR 0023](../docs/adr/0023-named-time-zones-come-from-a-standard-capability.md), [ADR 0033](../docs/adr/0033-the-error-catalogue-settles-its-fields-and-codes.md) |
| `ambiguous time` | `civil`, `zone` | `toInstant` with `"reject"` meets a DST gap or overlap; the Host fails with it | [ADR 0023](../docs/adr/0023-named-time-zones-come-from-a-standard-capability.md), [ADR 0033](../docs/adr/0033-the-error-catalogue-settles-its-fields-and-codes.md) |
| `bad locale` | `locale` | A `locale` call names a tag that isn't well-formed BCP 47; the Core checks before the Host function runs | [ADR 0024](../docs/adr/0024-locale-data-comes-from-a-standard-capability.md), [ADR 0033](../docs/adr/0033-the-error-catalogue-settles-its-fields-and-codes.md) |
| `object gone` | `object` | A `send … to` reaches a disposed Host Object, or a property of one is read or set | [ADR 0016](../docs/adr/0016-messages-reach-scripts-through-core-owned-object-parents.md), [ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md), [ADR 0033](../docs/adr/0033-the-error-catalogue-settles-its-fields-and-codes.md), [#71](https://github.com/odogono/odgn-talk/issues/71) |
| `read only` | none | A `set` targets a read-only Host Object property whose kind isn't known at load | [ADR 0016](../docs/adr/0016-messages-reach-scripts-through-core-owned-object-parents.md), [ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md), [#72](https://github.com/odogono/odgn-talk/issues/72) |
| `call lost` | none | A restored wait can't be kept: a pending call is still unsettled at the first Pump, or a `send … and wait` partner is outside the restored set | [ADR 0008](../docs/adr/0008-same-core-save-restore.md), [ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md), [ADR 0033](../docs/adr/0033-the-error-catalogue-settles-its-fields-and-codes.md), [#72](https://github.com/odogono/odgn-talk/issues/72) |

<!-- end -->

### Messages

Every Core-raised error carries a `message`, written from its template below. `{field}` stands for that field's value in the display form ([chapter 11](11-the-trace-and-conformance.md)). The wording is outside parity, and the Trace leaves `message` out of Core-raised errors. A Script's own `message` is data, so the Trace keeps it.

<!-- generated: errors.messages -->

| Code | Message |
| --- | --- |
| `bad throw` | Only a map with a text `code`, or a text, can be thrown |
| `no match` | The value doesn't match the pattern |
| `send failed` | No answer came: the receiver's Run ended {reason} |
| `mailbox full` | The mailbox of {to} is full |
| `capability revoked` | The Grant for {capability} is revoked, so {operation} can't be called |
| `wrong kind` | Expected {expected}, but got {got}: {value} |
| `can't convert` | Can't convert {value} to {to} |
| `can't compare` | Can't compare {left} with {right} |
| `division by zero` | Division by zero |
| `overflow` | The result of {operator} is too large |
| `incompatible units` | Can't combine {left} with {right} |
| `host error` | {capability} failed while doing {operation} |
| `timeout` | No answer came within {after} |
| `would suspend` | This function may wait, so call it with `and wait` |
| `function gone` | The function no longer exists |
| `wrong arity` | The function was called with the wrong number of arguments |
| `not encodable` | A {kind} can't be encoded as plain data |
| `out of domain` | {value} is outside the domain of {function} |
| `out of range` | {value} is out of range for {field} |
| `can't decode` | Invalid {format} at Character {offset} |
| `unknown zone` | Unknown time zone {zone} |
| `ambiguous time` | {civil} is ambiguous, or doesn't exist, in {zone} |
| `bad locale` | {locale} isn't a well-formed locale tag |
| `object gone` | {object} has been disposed |
| `read only` | That property is read-only |
| `call lost` | The call was lost in a restore |

<!-- end -->

## Limits

- **Set at load:** a Host sets a Script's limits when it loads the Script. A field left at zero takes its default, from the default limit profile below.
- **Tightened per Delivery:** `Deliver`, `Request`, `Broadcast`, `Decide` and `Call` take an optional override of the limits marked "yes" below. It can only tighten them, and an override that loosens one is the Host error `invalid value`. The Trace records the override. The Persistent State cap is Script-wide, and can't be overridden.
- **Runs started by a Script's `send`** get the receiving Script's limits, with no override.
- **No Script-side syntax:** a Script can't read or change its limits.
- **Conformance minimums:** every Core honours any value from 1 to a limit's minimum exactly. A Core may honour larger values too. A Core that can't honour a value refuses it at load, or in the override, as `invalid value`, and never quietly lowers it. Conformance cases stay within the minimums.

<!-- generated: limits -->

| Limit | Go | TS | Counts | Per | Tightened per Delivery | Default | Minimum | When exceeded | Sources |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Fuel per Run | `FuelPerRun` | `fuelPerRun` | Fuel | run | yes | 10,000,000 | 1,000,000,000 | a Limit Fault | [ADR 0006](../docs/adr/0006-limit-faults-roll-back-the-segment.md), [#71](https://github.com/odogono/odgn-talk/issues/71) |
| Allocation Budget | `AllocPerRun` | `allocPerRun` | logical size | run | yes | 16,777,216 | 268,435,456 | a Limit Fault | [ADR 0006](../docs/adr/0006-limit-faults-roll-back-the-segment.md), [#71](https://github.com/odogono/odgn-talk/issues/71) |
| Persistent State | `PersistentState` | `persistentState` | logical size | script | no | 1,048,576 | 67,108,864 | a Limit Fault, measured at each Segment end | [ADR 0006](../docs/adr/0006-limit-faults-roll-back-the-segment.md), [ADR 0010](../docs/adr/0010-normative-lowering-onto-a-stack-abstract-machine.md), [#71](https://github.com/odogono/odgn-talk/issues/71) |
| call depth | `CallDepth` | `callDepth` | frames | run | no | 200 | 1,000 | a Limit Fault, at the call | [ADR 0020](../docs/adr/0020-scripts-share-code-through-stateless-libraries.md), [#71](https://github.com/odogono/odgn-talk/issues/71) |
| mailbox depth | `MailboxDepth` | `mailboxDepth` | messages | script | no | 1,000 | 10,000 | `mailbox full` at a Script's `send`; `MailboxFull` at a Host call | [ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md), [#71](https://github.com/odogono/odgn-talk/issues/71) |
| MaxWait | `MaxWait` | `maxWaitMs` | whole milliseconds | wait | yes | 30,000 | 2,147,483,647 | `timeout`, and the call is abandoned | [ADR 0015](../docs/adr/0015-the-host-drives-the-core-through-a-pump.md), [ADR 0026](../docs/adr/0026-a-join-starts-several-calls-from-one-run-and-suspends-once.md), [#71](https://github.com/odogono/odgn-talk/issues/71) |
| MaxJoin | `MaxJoin` | `maxJoin` | Join Members | join | yes | 16 | 256 | a Limit Fault, at the member that would pass it | [ADR 0026](../docs/adr/0026-a-join-starts-several-calls-from-one-run-and-suspends-once.md), [#71](https://github.com/odogono/odgn-talk/issues/71) |
| Cleanup Budget | `CleanupBudget` | `cleanupBudget` | Fuel | run | no | 10,000 | 1,000,000 | the remaining cleanup ends, and the report says `cleanup failed` | [ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md) |

<!-- end -->

- **Fuel per Run** covers the Run's whole life, suspensions included. Each instruction's whole charge applies at it, so a Run that can't cover a charge faults at that instruction ([ADR 0010](../docs/adr/0010-normative-lowering-onto-a-stack-abstract-machine.md)). A Capability call charges its declared cost at the call, `Charge` only while the Operation starts, and a late cost when the Run resumes, where it can fault. A pending call costs no Fuel.
- **The Allocation Budget** counts the logical size of every value the Run constructs over its life, as if nothing were shared, with frees ignored.
- **Persistent State** counts, by logical size, everything the Script keeps between Segments: its Script Variables, the frames of its suspended, parked and preempted Runs, the answers a Join has received early, and the messages in its mailbox. It is measured at each Segment end, at a suspension or at the Run's end, and a breach faults the Run at that instruction. Growth within a Segment is the Allocation Budget's job.
- **Call depth** counts the frames on a Run's stack: its Handler and every Handler, function, Library and Lambda call inside it. A call that would pass it is a Limit Fault at the call.
- **Mailbox depth** counts the messages waiting in a Script's mailbox. Parked and suspended Runs don't count. A Script's `send` to a full mailbox raises `mailbox full`, and a Host call that would overfill one returns `MailboxFull`.
- **`MaxWait`** is the longest a call waits for an answer, in whole milliseconds on the Group's Clock: a suspending Operation call with no `maxPending` of its own, a `send … and wait`, and a call to a Function Value in another Script. Its deadline is the Clock reading of the Pump in which the call started, plus the limit. When it fires, the call is abandoned and the Run raises `timeout`. `wait` and `wait for` aren't bounded by it.
- **`MaxJoin`** is how many members one Join may start. Starting one more is a Limit Fault at that statement, and the members already started are abandoned.
- **The Cleanup Budget** is the Fuel a cancelled Run's `finally` blocks may spend ([below](#cancellation-and-stop)).

## Limit Faults

- **Uncatchable:** a Limit Fault ends the Run at once, as `limit fault`. No `catch` or `finally` runs, and no `error` message is sent. The report names the limit.
- **Rollback:** the failing Segment is rolled back, so the Script's Script Variables return to their bindings at the Segment's start. Nothing else is undone: effects already made in the Segment, such as immediate and fire-and-forget Capability calls and messages sent, are final ([ADR 0006](../docs/adr/0006-limit-faults-roll-back-the-segment.md)).
- **Pending calls,** including Join Members, are abandoned.
- **Other Runs** of the Script carry on.
- **Senders** of the message get `send failed`, reason `limit fault`, and a deciding Run that faults before its seal leaves its Decision undecided.

> **Rationale.** A catchable limit would turn a hard sandbox into a soft one, since `try` inside a loop could run past any budget. Rolling back keeps an exhausted Run from leaving a healthy Script's Script Variables half-written ([ADR 0006](../docs/adr/0006-limit-faults-roll-back-the-segment.md)).

## Cancellation and Stop

- **Cancelling a Run:** `, replacing`, `CancelRun`, and `cancel-delivery` from a cancelled `Request`, `Decide` or `Call`, cancel a Run.
  1. The Run's current Segment is rolled back, as for a Limit Fault. A suspended Run is between Segments, so nothing is rolled back.
  2. Its pending calls, including Join Members, are abandoned.
  3. Its `finally` blocks run, innermost first, all under one Cleanup Budget. The Fuel they spend is charged to the Cleanup Budget, not to the Run's Fuel. No `catch` clause runs.
  4. The Run ends as `cancelled`.
- **Cleanup that fails:** an error in a `finally` block, an exhausted Cleanup Budget, or any other limit exceeded during cleanup ends the remaining cleanup, outer blocks included. The Run still ends as `cancelled`, and the report and the Trace add `cleanup failed` with the error's code or the limit.
- **A Delivery still in the mailbox** that is cancelled is removed. It is reported as a `run end` with outcome `cancelled` and no Run or Handler.
- **A sender's cancellation** never cancels its receiver ([chapter 5](05-handlers-messages-and-scheduling.md#sending)).
- **Stop Script** is sticky. It discards the Script's running, parked and suspended Runs with no `finally`, and drops the messages in its mailbox. The senders waiting on any of them get `send failed`, reason `stopped`, and an open Decision settles as undecided, `cancelled`. The `stop` report lists what was discarded and dropped. Disposing a Script's owner stops it the same way, within the same Host Input, with reason `owner disposed`.

> **Rationale.** A `finally` that ran on a Limit Fault or Stop would be recovery code after running out of budget, and Stop means no more Script code. A cancelled Run has done nothing wrong, so its cleanup runs, but on a budget of its own ([ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md)).

## Outside parity

- **Messages:** the wording of `message` in a Core-raised error. Its presence is normative.
- **Beyond the minimums:** whether a Core honours a limit value above its conformance minimum.
