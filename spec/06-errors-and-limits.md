# 6. Errors and limits

_Draws on:_ [ADR 0006](../docs/adr/0006-limit-faults-roll-back-the-segment.md), [ADR 0010](../docs/adr/0010-normative-lowering-onto-a-stack-abstract-machine.md), [ADR 0015](../docs/adr/0015-the-host-drives-the-core-through-a-pump.md), [ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md), [ADR 0026](../docs/adr/0026-a-join-starts-several-calls-from-one-run-and-suspends-once.md).

> **Note.** Not yet written. The chapter 6 task writes this chapter.

## The error-code catalogue

<!-- generated: errors -->

| Code | Fields | Raised when | Sources |
| --- | --- | --- | --- |
| `bad throw` | none | `throw` is given something that isn't a map with a text `code`, or text | [ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md), [#61](https://github.com/odogono/odgn-talk/issues/61) |
| `no match` | none | A Destructuring test fails in `let` or in a Lambda's parameters, or a binary text decode fails | [ADR 0010](../docs/adr/0010-normative-lowering-onto-a-stack-abstract-machine.md), [ADR 0013](../docs/adr/0013-binary-patterns-are-sequential-destructuring.md), [ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md), [ADR 0025](../docs/adr/0025-lambdas-are-first-class-function-values-that-run-in-their-home-script.md) |
| `send failed` | `reason`, `error` | The receiver of a `send … and wait`, a Function Value call or a Host `Request` doesn't answer; `error` is present only when `reason` is `errored` | [ADR 0015](../docs/adr/0015-the-host-drives-the-core-through-a-pump.md), [ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md), [ADR 0025](../docs/adr/0025-lambdas-are-first-class-function-values-that-run-in-their-home-script.md), [ADR 0026](../docs/adr/0026-a-join-starts-several-calls-from-one-run-and-suspends-once.md), [ADR 0031](../docs/adr/0031-a-decisions-verdict-is-sealed-at-the-end-of-its-first-segment.md) |
| `mailbox full` | `to` | A `send` finds the receiver's mailbox full; it is raised at the `send`, even one that doesn't wait | [ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md), [ADR 0026](../docs/adr/0026-a-join-starts-several-calls-from-one-run-and-suspends-once.md) |
| `capability revoked` | `capability`, `operation` | A call goes through a revoked Grant | [ADR 0015](../docs/adr/0015-the-host-drives-the-core-through-a-pump.md), [ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md) |
| `wrong kind` | `expected`, `got`, `value` | An operand or argument has the wrong kind, e.g. a Text Pattern search on a value that isn't text | [ADR 0015](../docs/adr/0015-the-host-drives-the-core-through-a-pump.md), [ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md), [ADR 0023](../docs/adr/0023-named-time-zones-come-from-a-standard-capability.md), [ADR 0024](../docs/adr/0024-locale-data-comes-from-a-standard-capability.md), [ADR 0030](../docs/adr/0030-values-cross-the-host-boundary-as-tagged-values-converted-by-spec-rules.md) |
| `can't convert` | `to`, `value` | A conversion fails, e.g. `"lots" as number`, or a parse such as `parseDate` doesn't match | [ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md), [ADR 0021](../docs/adr/0021-the-stdlib-is-a-small-built-in-core-plus-libraries-written-in-the-language.md), [ADR 0023](../docs/adr/0023-named-time-zones-come-from-a-standard-capability.md), [ADR 0024](../docs/adr/0024-locale-data-comes-from-a-standard-capability.md) |
| `host error` | `capability`, `operation` | A Host function fails with something other than a Script error, a `Fail` misuses a reserved code or key, or a result breaks its Shape; it carries no Host detail | [ADR 0015](../docs/adr/0015-the-host-drives-the-core-through-a-pump.md), [ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md), [ADR 0030](../docs/adr/0030-values-cross-the-host-boundary-as-tagged-values-converted-by-spec-rules.md) |
| `timeout` | `capability`, `operation`, `after` | A suspending call runs past its `maxPending` or the Script's `MaxWait`, and is abandoned | [ADR 0015](../docs/adr/0015-the-host-drives-the-core-through-a-pump.md), [ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md) |
| `would suspend` | none | A Function Value that may suspend is called without `and wait`, or handed to a Library function such as `map` | [ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md), [ADR 0020](../docs/adr/0020-scripts-share-code-through-stateless-libraries.md), [ADR 0025](../docs/adr/0025-lambdas-are-first-class-function-values-that-run-in-their-home-script.md) |
| `function gone` | none | A stale Function Value is called, after a variables-only restore or a Library replace | [ADR 0008](../docs/adr/0008-same-core-save-restore.md), [ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md), [ADR 0025](../docs/adr/0025-lambdas-are-first-class-function-values-that-run-in-their-home-script.md) |
| `wrong arity` | none | A Lambda is called with the wrong number of arguments | [ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md), [ADR 0025](../docs/adr/0025-lambdas-are-first-class-function-values-that-run-in-their-home-script.md) |
| `not encodable` | `kind`, `at` | JSON encoding, or a data-Shaped Capability argument, meets a value plain data can't hold, such as a Quantity or Bytes | [ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md), [ADR 0021](../docs/adr/0021-the-stdlib-is-a-small-built-in-core-plus-libraries-written-in-the-language.md), [ADR 0025](../docs/adr/0025-lambdas-are-first-class-function-values-that-run-in-their-home-script.md) |
| `out of domain` | `function`, `value` | An argument is outside a function's domain, e.g. `sqrt(-1)`, a `format` key that's missing, or a bad sort direction | [ADR 0002](../docs/adr/0002-single-decimal-number-type.md), [ADR 0021](../docs/adr/0021-the-stdlib-is-a-small-built-in-core-plus-libraries-written-in-the-language.md), [ADR 0025](../docs/adr/0025-lambdas-are-first-class-function-values-that-run-in-their-home-script.md) |
| `out of range` | `field`, `value` | A date falls outside 0001–9999, or a date field isn't an in-range integer | [ADR 0023](../docs/adr/0023-named-time-zones-come-from-a-standard-capability.md) |
| `can't decode` | `format`, `at` | `decodeJson` is given invalid JSON | [ADR 0021](../docs/adr/0021-the-stdlib-is-a-small-built-in-core-plus-libraries-written-in-the-language.md) |
| `unknown zone` | `zone` | A `calendar` Operation is given an unknown IANA zone | [ADR 0023](../docs/adr/0023-named-time-zones-come-from-a-standard-capability.md) |
| `ambiguous time` | `civil`, `zone` | `toInstant` with `"reject"` meets a DST gap or overlap | [ADR 0023](../docs/adr/0023-named-time-zones-come-from-a-standard-capability.md) |
| `bad locale` | `locale` | A `locale` call names a tag that isn't well-formed BCP 47 | [ADR 0024](../docs/adr/0024-locale-data-comes-from-a-standard-capability.md) |
| `object gone` | `object` | A `send … to` reaches a disposed Host Object | [ADR 0016](../docs/adr/0016-messages-reach-scripts-through-core-owned-object-parents.md), [ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md), [#71](https://github.com/odogono/odgn-talk/issues/71) |
| `read only` | none | A `set` targets a read-only Host Object property whose kind isn't known at load | [ADR 0016](../docs/adr/0016-messages-reach-scripts-through-core-owned-object-parents.md), [ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md), [#72](https://github.com/odogono/odgn-talk/issues/72) |
| `call lost` | none | A restored pending call is still unsettled at the first Pump | [ADR 0008](../docs/adr/0008-same-core-save-restore.md), [ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md), [#72](https://github.com/odogono/odgn-talk/issues/72) |

Still open:

- `send failed`: [ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md) lists the reasons as Run outcomes plus `stopped`, but the embedding interface and [ADR 0025](../docs/adr/0025-lambdas-are-first-class-function-values-that-run-in-their-home-script.md) also use `function gone`.
- `wrong kind`: ADRs 0015 and 0030 give the fields as `operation`, `argument` and `expected` for a Capability argument that breaks its Shape.
- `can't convert`: ADRs 0023 and 0024 give the fields as `value`, `format` and `at`, with `at` as a position in the input rather than the source position.
- `host error`: [ADR 0015](../docs/adr/0015-the-host-drives-the-core-through-a-pump.md) and the embedding interface also use `host error` as a Run outcome, where [ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md) says an uncaught error ends the Run as `errored`.
- `not encodable`: `at` is a position inside the encoded value here, not the source position [ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md) gives it.
- `out of domain`: The fields are stated only for math functions.
- `can't decode`: `at` is a position in the input here, not the source position [ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md) gives it.
- `unknown zone`: It comes from a Standard Capability the Host implements, and [ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md) turns a Host `Fail` with a catalogue code into `host error`; who raises it is unstated.
- `ambiguous time`: As for `unknown zone`: who raises it is unstated.
- `bad locale`: As for `unknown zone`: who raises it is unstated.
- `object gone`: The embedding interface also raises it for reading or setting a disposed object's property, which no ADR states.

<!-- end -->

## Limits

<!-- generated: limits -->

| Limit | Go | TS | Counts | Per | Tightened per Delivery | Default | Sources |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Fuel per Run | `FuelPerRun` | `fuelPerRun` | Fuel | run | yes | not yet set | [ADR 0006](../docs/adr/0006-limit-faults-roll-back-the-segment.md), [#71](https://github.com/odogono/odgn-talk/issues/71) |
| Allocation Budget | `AllocPerRun` | `allocPerRun` | logical size | run | yes | not yet set | [ADR 0006](../docs/adr/0006-limit-faults-roll-back-the-segment.md), [#71](https://github.com/odogono/odgn-talk/issues/71) |
| Persistent State | `PersistentState` | `persistentState` | logical size | script | no | not yet set | [ADR 0006](../docs/adr/0006-limit-faults-roll-back-the-segment.md), [ADR 0010](../docs/adr/0010-normative-lowering-onto-a-stack-abstract-machine.md), [#71](https://github.com/odogono/odgn-talk/issues/71) |
| call depth | `CallDepth` | `callDepth` | frames | run | no | not yet set | [ADR 0020](../docs/adr/0020-scripts-share-code-through-stateless-libraries.md), [#71](https://github.com/odogono/odgn-talk/issues/71) |
| mailbox depth | `MailboxDepth` | `mailboxDepth` | messages | script | no | not yet set | [ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md), [#71](https://github.com/odogono/odgn-talk/issues/71) |
| MaxWait | `MaxWait` | `maxWaitMs` | whole milliseconds | wait | yes | not yet set | [ADR 0015](../docs/adr/0015-the-host-drives-the-core-through-a-pump.md), [#71](https://github.com/odogono/odgn-talk/issues/71) |
| MaxJoin | `MaxJoin` | `maxJoin` | Join Members | join | yes | not yet set | [ADR 0026](../docs/adr/0026-a-join-starts-several-calls-from-one-run-and-suspends-once.md), [#71](https://github.com/odogono/odgn-talk/issues/71) |
| Cleanup Budget | `CleanupBudget` | `cleanupBudget` | Fuel | run | no | not yet set | [ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md) |

<!-- end -->

## Outside parity

_None yet._
