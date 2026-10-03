# Load diagnostics

These 30 Trace Cases pin the diagnostic families the Go step 1 front end emits
(#250). Each rejected `load` is followed by its diagnostics in source order.
`> vars` then confirms that a refused load installed no Script. The TS Core
blessed only these new cases; existing blessed expectations were not changed.

**Human review is pending.** #250 and the decisions on #132 require a human to
review each new case's source and blessed records. This table presents that
review surface; blessing alone does not establish conformance.

Go's static checker compares its complete diagnostic list with these records.
The `initialiser failed` boundary test obtains its position from executing the
fixture's actual lowered division instruction. The full Abstract Machine and
worker Trace replay arrive in #251; #249's runner already reads these records. Handler, Library and
Capability diagnostics deferred to step 3 are listed beside the checker in
[the Go guide](../../impl/go/README.md#front-end-and-lowering-checks).

| Source | Expected diagnostic records | Blessed output |
| --- | --- | --- |
| [bad-number](bad-number/bad.talk) | `bad number` at `1:14` | [Trace](bad-number/case.trace) |
| [bits-not-whole-bytes](bits-not-whole-bytes/bad.talk) | `bits not whole bytes` at `2:10` | [Trace](bits-not-whole-bytes/case.trace) |
| [cant-suspend-here](cant-suspend-here/bad.talk) | `can't suspend here` at `2:1` | [Trace](cant-suspend-here/case.trace) |
| [cant-write](cant-write/bad.talk) | `can't write` at `3:12` | [Trace](cant-write/case.trace) |
| [capture-in-repetition](capture-in-repetition/bad.talk) | `capture in repetition` at `2:18` | [Trace](capture-in-repetition/case.trace) |
| [default-order](default-order/bad.talk) | `default order` at `1:19` | [Trace](default-order/case.trace) |
| [duplicate-key](duplicate-key/bad.talk) | `duplicate key` at `2:15` | [Trace](duplicate-key/case.trace) |
| [duplicate-name](duplicate-name/bad.talk) | `duplicate name` at `2:9` | [Trace](duplicate-name/case.trace) |
| [empty-join](empty-join/bad.talk) | `empty join` at `2:1` | [Trace](empty-join/case.trace) |
| [initialiser-failed](initialiser-failed/bad.talk) | `initialiser failed` at `1:16` | [Trace](initialiser-failed/case.trace) |
| [leaves-finally](leaves-finally/bad.talk) | `leaves finally` at `4:1` | [Trace](leaves-finally/case.trace) |
| [name-clash](name-clash/bad.talk) | `name clash` at `2:6` | [Trace](name-clash/case.trace) |
| [needless-and-wait](needless-and-wait/bad.talk) | `needless and wait` at `2:1` | [Trace](needless-and-wait/case.trace) |
| [no-conversion](no-conversion/bad.talk) | `no conversion` at `2:10` | [Trace](no-conversion/case.trace) |
| [no-item-chunk](no-item-chunk/bad.talk) | `no item chunk` at `2:20` | [Trace](no-item-chunk/case.trace) |
| [not-a-property](not-a-property/bad.talk) | `not a property` at `2:1` | [Trace](not-a-property/case.trace) |
| [not-a-value](not-a-value/bad.talk) | `not a value` at `2:8` | [Trace](not-a-value/case.trace) |
| [not-constant](not-constant/bad.talk) | `not constant` at `2:14` | [Trace](not-constant/case.trace) |
| [not-in-a-guard](not-in-a-guard/bad.talk) | `not in a guard` at `4:14` | [Trace](not-in-a-guard/case.trace) |
| [not-in-a-join](not-in-a-join/bad.talk) | `empty join` at `2:1`, `not in a join` at `3:1` | [Trace](not-in-a-join/case.trace) |
| [not-in-a-lambda](not-in-a-lambda/bad.talk) | `not in a lambda` at `2:12` | [Trace](not-in-a-lambda/case.trace) |
| [not-in-a-script](not-in-a-script/bad.talk) | `not in a script` at `1:1` | [Trace](not-in-a-script/case.trace) |
| [nothing-to-fold](nothing-to-fold/bad.talk) | `nothing to fold` at `2:22` | [Trace](nothing-to-fold/case.trace) |
| [outside-a-loop](outside-a-loop/bad.talk) | `outside a loop` at `2:1` | [Trace](outside-a-loop/case.trace) |
| [pattern-too-large](pattern-too-large/bad.talk) | `pattern too large` at `2:8` | [Trace](pattern-too-large/case.trace) |
| [rest-not-last](rest-not-last/bad.talk) | `rest not last` at `2:6` | [Trace](rest-not-last/case.trace) |
| [unknown-import](unknown-import/bad.talk) | `unknown import` at `1:12` | [Trace](unknown-import/case.trace) |
| [unknown-kind](unknown-kind/bad.talk) | `unknown kind` at `2:15` | [Trace](unknown-kind/case.trace) |
| [unknown-name](unknown-name/bad.talk) | `unknown name` at `2:8` | [Trace](unknown-name/case.trace) |
| [wrong-argument-count](wrong-argument-count/bad.talk) | `wrong argument count` at `5:8` | [Trace](wrong-argument-count/case.trace) |
