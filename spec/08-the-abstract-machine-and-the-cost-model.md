# 8. The Abstract Machine and the Cost Model

_Draws on:_ [ADR 0001](../docs/adr/0001-value-semantics.md), [ADR 0006](../docs/adr/0006-limit-faults-roll-back-the-segment.md), [ADR 0009](../docs/adr/0009-twin-cores-held-to-bit-for-bit-parity.md), [ADR 0010](../docs/adr/0010-normative-lowering-onto-a-stack-abstract-machine.md), [ADR 0013](../docs/adr/0013-binary-patterns-are-sequential-destructuring.md), [ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md), [ADR 0020](../docs/adr/0020-scripts-share-code-through-stateless-libraries.md), [ADR 0021](../docs/adr/0021-the-stdlib-is-a-small-built-in-core-plus-libraries-written-in-the-language.md), [ADR 0025](../docs/adr/0025-lambdas-are-first-class-function-values-that-run-in-their-home-script.md), [ADR 0026](../docs/adr/0026-a-join-starts-several-calls-from-one-run-and-suspends-once.md), [ADR 0035](../docs/adr/0035-trailing-function-parameters-may-have-constant-defaults.md), [ADR 0037](../docs/adr/0037-errors-raised-in-stdlib-code-point-at-the-scripts-call.md).

Every Script and Library compiles to a code unit for one Abstract Machine: a stack machine with numbered local slots. The instruction set, and the exact instructions each construct lowers to, are normative, including which local slot each name gets and the order of the constant pool ([ADR 0010](../docs/adr/0010-normative-lowering-onto-a-stack-abstract-machine.md)). Each instruction is one language-level operation, and is charged Fuel by the Cost Model. So both Cores charge the same Fuel, fault at the same instruction and report the same positions, and a Disassembly Case can pin a Script's lowering exactly ([chapter 11](11-the-trace-and-conformance.md)).

## The machine's state

The state is defined abstractly. A Core may represent it any way it likes, as long as it behaves as stated here.

- **A Group** holds its Scripts, in the order they were loaded, and the code units of its Libraries, with the Clock reading, the input queue and the counters for ids ([chapter 5](05-handlers-messages-and-scheduling.md), [chapter 9](09-embedding.md)).
- **A Script** holds its code unit, its Script Variables (one slot each, in declaration order), the values of its code unit's definitions, its mailbox and work queue, its Runs, and each clause's queue of parked Runs.
- **A Run** holds:
  - its stack of frames, and its status: running, ready, suspended, parked or preempted
  - the Fuel and allocation it has used, and the Cleanup Budget spent
  - its segment base: the Script Variables' bindings when its Segment began, for rollback ([ADR 0006](../docs/adr/0006-limit-faults-roll-back-the-segment.md))
  - its Delivery: the message's name and arguments, `me`, `the target`, its delivery id, and its open Verdict, if it holds one
  - while it dispatches, the Handler and the number of the clause being tried, and the arguments
  - while it waits, its wait: for `wait`, its deadline; for `wait-for` and `wait-for-any`, the event entry, the values the instruction popped, each `after` branch's deadline, and its place in the order waits began
  - its pending calls, each with its call id, and for an open Join, each member in start order, with its answer once it has one
  - its cleanup stack: one entry per `finally` block it is running because of an error or a cancellation, giving the frame, the entry, and the error, or that it is a cancellation
- **A frame** holds its code unit, its body, its pc (an instruction index in the code unit), its locals (as many as the body table says, [below](#bodies)) and its operand stack. A new frame's locals are all Nothing, apart from the arguments.
- **A Function Value** is its Home Script, its body (a code unit and a body index, or an imported function), its captured values and its may-suspend flag. It is stale when, since it was made, its Home Script has stopped or reloaded, or its code has been replaced. Extending the Script doesn't make it stale ([chapter 10](10-save-and-restore.md#extend-script)) ([chapter 3](03-values.md#function-values)).
- **Values on the operand stack** are Script values, plus three internal values that only instructions can see, and that are plain data too:
  - an **iterator**: a list or range snapshot and a position, or a count left
  - a **replacement**: a text, its Matches, a position and the pieces so far
  - a **reader**: Bytes, a position and the bits left over from a bit field

## Code units

A code unit is the compiled form of one Script or Library. It holds, in order:

1. **The constant pool:** each distinct constant, in the order the lowering first uses it. A Lambda's or an event test's body is lowered where its construct appears, so its constants are numbered there. A constant is a number, a Quantity, a text, `true`, `false` or `nothing`, a Built-in Constant by name, a list of map keys, a Text Pattern with no splices, a Text Pattern template whose splices are numbered `(1)`, `(2)`, …, a list of bit-field widths, or the empty Bytes `<<>>`.
2. **The definitions:** first each Constant that a `use` line imports or the unit declares, in source order, then each function parameter's default, in source order. The initialiser computes the unit's own ones when the unit loads.
3. **The variables:** the Script Variables, in declaration order.
4. **The objects:** each well-known object name and Script name the code uses, in first-use order. The Host binds them at load ([chapter 9](09-embedding.md)).
5. **The body table** ([below](#bodies)).
6. **The code:** one array of instructions for every body, each body's a contiguous range, in body order.
7. **The Unwind Table** ([below](#the-unwind-table)).
8. **The event table** ([below](#the-event-table)).

- **Code positions:** a code position is a code unit and an instruction index in it, so a Run paused inside Library code is still a position a Snapshot can hold ([ADR 0020](../docs/adr/0020-scripts-share-code-through-stateless-libraries.md)).
- **Code identity** covers the source, the language and Cost Model versions, and the identities of the Libraries it imports ([chapter 7](07-libraries-and-the-standard-library.md)).

### Bodies

The body table lists every body of the code unit, in this order:

1. **The initialiser**, body 0, named `initialiser`. It evaluates each Script Variable's initial value, each Constant and each parameter default, in source order, stores them with `store-var` or `store-definition`, and ends with `const nothing` and `return`. It runs once, when the unit loads.
2. **Each function, and each Handler Clause,** in source order. A Handler's clauses are numbered from 1, in source order.
3. **Each Lambda and each event test,** in the order the lowering reaches it: in the initialiser first, then in each declaration in source order.

Each entry gives the body's kind (`init`, `function`, `handler`, `lambda` or `event`), its name, its clause number, its parameters, its defaults, its number of captures, its number of locals, whether it may suspend, and its range of instructions. A Lambda is named by its enclosing body's name, then its position (`compare:25:8`, `compare:25:8:25:20` for a Lambda inside it, and `initialiser:3:14` for one in a Constant), and an event test by its message.

- **May suspend:** a body may suspend when it holds a Suspension Point instruction (`suspends` in the table below). For a Lambda, the flag is part of the Function Value ([ADR 0025](../docs/adr/0025-lambdas-are-first-class-function-values-that-run-in-their-home-script.md)). A Handler that may suspend is one whose body may, or that calls one that may, found by the loader over the call graph ([chapter 5](05-handlers-messages-and-scheduling.md)).

### Slots

Each body numbers its locals from 0, in this order:

1. **Slot 0** is `it`.
2. **The arguments,** from slot 1: for a function, its parameters. For a Handler Clause, a Lambda or an event test, one slot per parameter: a parameter that is a plain name is that name's slot, and any other pattern's argument has a slot of its own.
3. **The names a parameter pattern binds**, left to right.
4. **The captures** of a Lambda or an event test, in the order its code first names them ([Lambdas](#calls-lambdas-and-function-values)).
5. **The body's other locals**, in the order their first binding sites appear in the source ([chapter 4](04-expressions-and-statements.md#bodies-and-locals)). A binding site is a name in a pattern, a Capture written in a Text Pattern that binds, or a Container's root, and one inside a nested Lambda doesn't count.
6. **Temps:** a lowering that needs a slot of its own takes the lowest-numbered temp that isn't in use, or else a new slot after all the others. It releases the temp when the construct that took it has been lowered, as each rule below says.

## The instruction set

Each instruction's operands, stack effect and Error Codes are in [`machine.toml`](data/machine.toml). A count such as `count + 1` is given by the instruction's operand of that kind. An `event` operand counts the values its entry takes ([below](#the-event-table)). An instruction with a label either continues with the next instruction, or jumps and leaves what "on a jump" says.

The operand kinds:

<!-- generated: machine.operands -->

| Operand kind | Is |
| --- | --- |
| `constant` | an index into the code unit's constant pool, shown with the constant |
| `local` | a local slot of the current body, shown with its name |
| `variable` | a Script Variable's slot, shown with its name |
| `definition` | a Constant of the code unit or of an Import, shown by its name in the definitions |
| `body` | a body of the code unit, shown by its index, with its name |
| `import` | an imported function, Handler or Constant, shown as library:name |
| `builtin` | a Built-in function, shown by name |
| `handler` | a Handler of the code unit, or an imported one, shown by name |
| `grant` | a Grant, by the name the Script uses |
| `operation` | an Operation name |
| `message` | a message name |
| `object` | a well-known object or Script name, shown by name |
| `label` | an instruction index in the same body, shown as the code's indices are |
| `count` | a non-negative integer |
| `index` | a positive integer |
| `kind` | a kind name, `integer`, or a Unit, as written after `is a`, `as` or `can be` |
| `chunk` | a chunk kind: character, word, line, item, byte or code point |
| `property` | a Built-in property name |
| `key` | a map key, shown as text in the display form |
| `fold` | `fold` if the operation ignores case, and absent otherwise |
| `field` | a Binary Pattern field type: an integer type with its byte order, or a size unit |
| `event` | an entry of the code unit's event table |
| `code` | an Error Code from errors.toml |

<!-- end -->

### Values and slots

<!-- generated: machine.values -->

| Instruction | Operands | Pops | Pushes | Does | Raises |
| --- | --- | --- | --- | --- | --- |
| `const` | `constant` | 0 | 1 | Pushes a constant from the pool |  |
| `pop` |  | 1 | 0 | Discards the top value |  |
| `load` | `local` | 0 | 1 | Pushes a local |  |
| `store` | `local` | 1 | 0 | Pops a value into a local |  |
| `move` | `local`, `local` | 0 | 0 | Copies the first local into the second, which commits a pattern's binding |  |
| `load-var` | `variable` | 0 | 1 | Pushes a Script Variable |  |
| `store-var` | `variable` | 1 | 0 | Pops a value into a Script Variable |  |
| `load-definition` | `definition` | 0 | 1 | Pushes a Constant, the code unit's own or an imported one |  |
| `store-definition` | `definition` | 1 | 0 | Pops a Constant's value, in the code unit's initialiser only |  |
| `load-object` | `object` | 0 | 1 | Pushes the well-known Host Object or Script bound to a name at load |  |
| `me` |  | 0 | 1 | Pushes `me` |  |
| `target` |  | 0 | 1 | Pushes `the target` |  |

<!-- end -->

### Control

<!-- generated: machine.control -->

| Instruction | Operands | Pops | Pushes | Does | Raises |
| --- | --- | --- | --- | --- | --- |
| `jump` | `label` | 0 | 0 | Continues at the label |  |
| `branch-false` | `label` | 1 | 0 | Pops a boolean and continues at the label if it is false | `wrong kind` |
| `branch-true` | `label` | 1 | 0 | Pops a boolean and continues at the label if it is true | `wrong kind` |
| `check-boolean` |  | 1 | 1 | Raises `wrong kind` unless the top value is a boolean | `wrong kind` |
| `not` |  | 1 | 1 | Negates a boolean | `wrong kind` |

<!-- end -->

### Operators

Each operator does what [chapter 3](03-values.md) and [chapter 4](04-expressions-and-statements.md#operators) say, on the two values it pops, the first pushed being the left operand.

<!-- generated: machine.operators -->

| Instruction | Operands | Pops | Pushes | Does | Raises |
| --- | --- | --- | --- | --- | --- |
| `add` |  | 2 | 1 | `a + b` | `wrong kind`, `incompatible units`, `overflow`, `out of range` |
| `subtract` |  | 2 | 1 | `a - b` | `wrong kind`, `incompatible units`, `overflow`, `out of range` |
| `multiply` |  | 2 | 1 | `a * b` | `wrong kind`, `incompatible units`, `overflow` |
| `divide` |  | 2 | 1 | `a / b` | `wrong kind`, `incompatible units`, `overflow`, `division by zero` |
| `div` |  | 2 | 1 | `a div b` | `wrong kind`, `overflow`, `division by zero` |
| `mod` |  | 2 | 1 | `a mod b` | `wrong kind`, `division by zero` |
| `power` |  | 2 | 1 | `a ^ b` | `wrong kind`, `incompatible units`, `overflow`, `division by zero`, `out of domain` |
| `negate` |  | 1 | 1 | Unary `-a` | `wrong kind` |
| `concat` |  | 2 | 1 | `a & b` |  |
| `range` |  | 2 | 1 | `a..b` | `wrong kind`, `incompatible units` |
| `equal` | `fold` (optional) | 2 | 1 | `a = b`, and `a is b` |  |
| `not-equal` | `fold` (optional) | 2 | 1 | `a <> b`, and `a is not b` |  |
| `less` | `fold` (optional) | 2 | 1 | `a < b` | `can't compare` |
| `greater` | `fold` (optional) | 2 | 1 | `a > b` | `can't compare` |
| `less-or-equal` | `fold` (optional) | 2 | 1 | `a <= b` | `can't compare` |
| `greater-or-equal` | `fold` (optional) | 2 | 1 | `a >= b` | `can't compare` |
| `member` | `fold` (optional) | 2 | 1 | `a is in b` | `wrong kind`, `can't compare` |
| `is-kind` | `kind` | 1 | 1 | `a is a K`, and `a is an integer` |  |
| `is-empty` |  | 1 | 1 | `a is empty` |  |
| `can-convert` | `kind` | 1 | 1 | `a can be K` |  |
| `convert` | `kind` | 1 | 1 | `a as K` | `can't convert`, `out of range` |
| `contains` | `fold` (optional) | 2 | 1 | `a contains b` | `wrong kind` |
| `begins-with` | `fold` (optional) | 2 | 1 | `a begins with b` | `wrong kind` |
| `ends-with` | `fold` (optional) | 2 | 1 | `a ends with b` | `wrong kind` |
| `matches` | `fold` (optional) | 2 | 1 | `a matches b` | `wrong kind` |

<!-- end -->

### Keys, properties and chunks

<!-- generated: machine.access -->

| Instruction | Operands | Pops | Pushes | Does | Raises |
| --- | --- | --- | --- | --- | --- |
| `get-key` | `key` | 1 | 1 | `the k of x`: a map's value, or a Host Object's property | `wrong kind`, `object gone` |
| `get-key-computed` |  | 2 | 1 | `the (k) of x`, with the key below the value | `wrong kind`, `object gone` |
| `property` | `property` | 1 | 1 | `the p of x`, for a Built-in property | `wrong kind` |
| `property-delimited` | `property` | 2 | 1 | `the items of x delimited by d`, with the delimiter on top | `wrong kind`, `out of range` |
| `chunk-get` | `chunk` | 2 | 1 | One chunk level: pops the value, then its index, and pushes the chunk | `wrong kind` |
| `chunk-get-delimited` | `chunk` | 3 | 1 | An `item` level with its delimiter: pops the delimiter, the value and the index | `wrong kind`, `out of range` |
| `chunk-set` | `chunk` | 3 | 1 | One chunk level of a write: pops the new part, the whole and the index, and pushes the new whole | `wrong kind`, `out of range` |
| `chunk-set-delimited` | `chunk` | 4 | 1 | An `item` level of a write, with its delimiter on top | `wrong kind`, `out of range` |
| `chunk-delete` | `chunk` | 2 | 1 | `delete` of one chunk level: pops the whole and the index, and pushes the new whole | `wrong kind` |
| `chunk-delete-delimited` | `chunk` | 3 | 1 | `delete` of an `item` level, with its delimiter on top | `wrong kind`, `out of range` |
| `test-chunk` | `chunk`, `label` | 2 | 0 | For `delete`: pops the value and the index, and jumps to the label if that chunk isn't there | `wrong kind` |
| `test-chunk-delimited` | `chunk`, `label` | 3 | 0 | `test-chunk` for an `item` level with its delimiter on top | `wrong kind`, `out of range` |
| `test-key` | `key`, `label` | 1 | 0 | For `delete`: pops a map, and jumps to the label if it has no such key | `wrong kind` |
| `test-key-computed` | `label` | 2 | 0 | `test-key` with the key below the map | `wrong kind` |
| `set-key` | `key` | 2 | 1 | One key level of a write: pops the new value and the map, and pushes the new map | `wrong kind` |
| `set-key-computed` |  | 3 | 1 | A computed key level of a write: pops the new value, the map and the key | `wrong kind` |
| `delete-key` | `key` | 1 | 1 | `delete` of a key: pops the map, and pushes it without the key | `wrong kind` |
| `delete-key-computed` |  | 2 | 1 | `delete` of a computed key: pops the map and the key | `wrong kind` |
| `append` |  | 2 | 1 | `put e after c`: pops `e` and the current value, and pushes the new value | `wrong kind` |
| `prepend` |  | 2 | 1 | `put e before c` | `wrong kind` |
| `append-all` |  | 2 | 1 | `put ...e after c` | `wrong kind` |
| `prepend-all` |  | 2 | 1 | `put ...e before c` | `wrong kind` |
| `set-property` | `key` | 2 | 0 | `set the p of o to e`: pops the value and the Host Object, and calls the Host's `Set` | `wrong kind`, `read only`, `object gone` |
| `set-property-computed` |  | 3 | 0 | `set the (k) of o to e`: pops the value, the Host Object and the key | `wrong kind`, `read only`, `object gone` |

<!-- end -->

### Building values

<!-- generated: machine.building -->

| Instruction | Operands | Pops | Pushes | Does | Raises |
| --- | --- | --- | --- | --- | --- |
| `list` | `count` | count | 1 | Pops `count` values and pushes them as a list, the deepest first |  |
| `list-append` |  | 2 | 1 | Pops a value and a list, and pushes the list with the value added last |  |
| `list-extend` |  | 2 | 1 | `...e` in a list literal: pops a list and the list so far, and pushes them joined | `wrong kind` |
| `map` | `constant`, `count` | count | 1 | Pops `count` values and pushes a map with the keys the constant lists, in order |  |
| `make-pattern` | `constant`, `count` | count | 1 | Builds a Text Pattern from the constant's template and `count` spliced values | `wrong kind`, `can't convert` |
| `bytes-field` | `field` | 2 | 1 | One field of a `<< … >>` build: pops the value and the Bytes so far, and pushes them extended | `wrong kind`, `out of range` |
| `bytes-sized` | `field` | 3 | 1 | A `v as n bytes` field of a build: pops the size, the value and the Bytes so far, and pushes them extended | `wrong kind`, `out of range` |
| `bytes-bits` | `constant`, `count` | count + 1 | 1 | A run of `count` bit fields, with the widths the constant lists: pops their values and the Bytes so far | `wrong kind`, `out of range` |
| `match-all` |  | 2 | 1 | `every match of p in s`: pops the text and the pattern, and pushes the list of Matches | `wrong kind` |
| `replace-start` | `count` | 2 | 1 | Pops the text and the pattern, and pushes a replacement over its matches, only the first if `count` is 1 | `wrong kind` |
| `replace-next` | `label` | 1 | 2, 1 on a jump | Pushes the replacement's next Match, or jumps to the label when there are none |  |
| `replace-put` |  | 2 | 1 | Pops the text for the current Match, shown as `&` shows it, and the replacement |  |
| `replace-end` |  | 1 | 1 | Pops the replacement, and pushes the finished text |  |
| `make-closure` | `body`, `count` | count | 1 | Pops `count` captured values and pushes a Function Value of the Lambda body |  |
| `make-function` | `body` | 0 | 1 | Pushes a named function as a Function Value, with no captures |  |
| `make-imported-function` | `import` | 0 | 1 | Pushes an imported function as a Function Value |  |

<!-- end -->

### Calls

<!-- generated: machine.calls -->

| Instruction | Operands | Pops | Pushes | Does | Raises |
| --- | --- | --- | --- | --- | --- |
| `call` | `body`, `count` | count | 1 | Calls a function of the code unit with `count` arguments, and pushes its result |  |
| `call-import` | `import`, `count` | count | 1 | Calls an imported function with `count` arguments |  |
| `call-handler` | `handler`, `count` | count | 1 | Calls a Handler of the Script or an imported one, trying its clauses in order | `no match` |
| `call-handler-wait` (suspends) | `handler`, `count` | count | 1 | `name args and wait`: calls a Handler that may suspend, as `call-handler` does, and suspends when its body does | `no match` |
| `call-builtin` | `builtin`, `count` | count | 1 | Calls a Built-in function, charged by its own Cost Model key |  |
| `call-value` | `count` | count + 1 | 1 | Calls the Function Value below the `count` arguments, which must run here without suspending | `wrong kind`, `function gone`, `wrong arity`, `would suspend` |
| `call-value-wait` (suspends) | `count` | count + 1 | 1 | `f(x) and wait`: calls a local Function Value, or sends a foreign one to its Home Script and waits | `wrong kind`, `function gone`, `wrong arity`, `send failed`, `timeout` |
| `return` |  | 1 | 0 | Ends the body with the popped value as its result |  |
| `clause-fail` |  | 0 | 0 | Ends a failed clause, test or branch body, so the Core tries the next |  |

<!-- end -->

### Destructuring

The test instructions never raise on a value of the wrong kind: they jump. A test pops its subject whether or not it jumps, and a Binary Pattern instruction that jumps pops its reader too.

<!-- generated: machine.patterns -->

| Instruction | Operands | Pops | Pushes | Does | Raises |
| --- | --- | --- | --- | --- | --- |
| `test-constant` | `constant`, `fold` (optional), `label` | 1 | 0 | Pops a value, and jumps to the label unless it `=` the constant |  |
| `test-equal` | `label` | 2 | 0 | Pops two values, and jumps to the label unless they are `=`, for a pin |  |
| `test-list` | `count`, `label` | 1 | 0 | Pops a value, and jumps unless it is a list of exactly `count` items |  |
| `test-list-at-least` | `count`, `label` | 1 | 0 | Pops a value, and jumps unless it is a list of `count` items or more |  |
| `list-item` | `index` | 1 | 1 | Pops a list the pattern has tested, and pushes its item at `index` |  |
| `list-rest` | `index` | 1 | 1 | Pops a list the pattern has tested, and pushes its items from `index` on |  |
| `test-map` | `label` | 1 | 0 | Pops a value, and jumps unless it is a map |  |
| `map-get` | `key`, `label` | 1 | 1 | Pops a map, and pushes its value under the key, or jumps if it has no such key |  |
| `match-whole` | `fold` (optional), `label` | 2 | 1 | Pops a Text Pattern and a value, and pushes the Captures map of a whole-text match, or jumps |  |
| `match-search` | `fold` (optional), `label` | 2 | 1 | Pops a Text Pattern and a value, and pushes the Captures map of the first match, or jumps |  |
| `bin-start` | `label` | 1 | 1 | Pops a value, and pushes a reader at its first byte, or jumps unless it is Bytes |  |
| `bin-literal` | `constant`, `label` | 1 | 1 | Reads the constant's bytes, or pops the reader and jumps if they differ or run out |  |
| `bin-int` | `field`, `label` | 1 | 2 | Reads an integer field and pushes it above the reader, or pops the reader and jumps |  |
| `bin-bits` | `constant`, `count`, `label` | 1 | count + 1 | Reads a run of `count` bit fields of the widths the constant lists, and pushes each above the reader |  |
| `bin-bytes` | `field`, `label` | 2 | 2 | Pops a size, and reads that many bytes, as Bytes or as text, above the reader, or pops the reader and jumps |  |
| `bin-rest` | `field`, `label` | 1 | 1 | Pops the reader, and pushes the bytes left, as Bytes or as text, or jumps if they don't decode |  |
| `bin-end` | `label` | 1 | 0 | Pops the reader, and jumps unless every byte was read |  |

<!-- end -->

### Loops

<!-- generated: machine.loops -->

| Instruction | Operands | Pops | Pushes | Does | Raises |
| --- | --- | --- | --- | --- | --- |
| `iterate` |  | 1 | 1 | Pops a list or an integer range, and pushes an iterator over a snapshot of it | `wrong kind` |
| `iterate-times` |  | 1 | 1 | Pops a count, and pushes an iterator that runs that many times | `wrong kind`, `out of range` |
| `next` | `label` | 1 | 2, 1 on a jump | Pushes the iterator's next item above it, or jumps to the label, leaving the iterator, when there are none |  |

<!-- end -->

### Errors

<!-- generated: machine.errors -->

| Instruction | Operands | Pops | Pushes | Does | Raises |
| --- | --- | --- | --- | --- | --- |
| `throw` |  | 1 | 0 | `throw e`: raises the popped map or text | `bad throw` |
| `rethrow` |  | 1 | 0 | Raises the popped error again, from a `catch` block no clause matched |  |
| `raise` | `code` | 0 | 0 | Raises a catalogue error that has no fields, such as `no match` |  |
| `end-cleanup` |  | 0 | 0 | Ends a `finally` block reached by an error or a cancellation, which then goes on |  |

<!-- end -->

### Effects and suspension

<!-- generated: machine.effects -->

| Instruction | Operands | Pops | Pushes | Does | Raises |
| --- | --- | --- | --- | --- | --- |
| `ask` | `grant`, `operation`, `count` | count | 1 | Calls an immediate Operation, and pushes its result | `wrong kind`, `capability revoked`, `host error` |
| `ask-wait` (suspends) | `grant`, `operation`, `count` | count | 1 | Calls a suspending Operation, and suspends until it answers | `wrong kind`, `capability revoked`, `host error`, `timeout` |
| `tell` | `grant`, `operation`, `count` | count | 0 | Calls a fire-and-forget Operation | `wrong kind`, `capability revoked`, `host error` |
| `send` | `message`, `count` | count + 1 | 0 | Pops the receiver and `count` arguments, and puts the message in the receiver's mailbox | `mailbox full`, `object gone`, `wrong kind` |
| `send-wait` (suspends) | `message`, `count` | count + 1 | 1 | Sends as `send` does, then suspends until the reply | `mailbox full`, `object gone`, `wrong kind`, `send failed`, `timeout` |
| `send-up` | `message`, `count` | count | 0 | A Command Call with no Handler: sends the message up the Message Path | `mailbox full` |
| `send-up-wait` (suspends) | `message`, `count` | count | 1 | `name args and wait` with no Handler: sends up the Message Path and waits | `mailbox full`, `send failed`, `timeout` |
| `wait` (suspends) |  | 1 | 0 | `wait d`: pops an exact duration, and suspends until it has passed | `wrong kind` |
| `wait-for` (suspends) | `event` | event | 1 | Suspends until an event of the entry arrives, and pushes the message, or Nothing on a timeout | `wrong kind` |
| `wait-for-any` (suspends) | `event` | event | 2 | The block `wait for`: suspends until a branch fires, and pushes its message or Nothing, then its number | `wrong kind` |
| `join-start` |  | 0 | 0 | Starts a Join |  |
| `join-ask` | `grant`, `operation`, `count` | count | 0 | Starts a suspending Operation as a Join Member | `wrong kind`, `capability revoked` |
| `join-send` | `message`, `count` | count + 1 | 0 | Starts a `send … and wait` as a Join Member | `mailbox full`, `object gone`, `wrong kind` |
| `join-end` (suspends) |  | 0 | 1 | `end wait`: suspends until every member answers, and pushes their answers in start order, or raises the first failure, with `index`; with no members it pushes `[]` and doesn't suspend | `send failed`, `timeout` |
| `veto` |  | 1 | 0 | Pops the reason, vetoes the Decision and ends the Run |  |
| `pass` | `message` | 0 | 0 | Ends the Run and sends its message on up the Message Path |  |

<!-- end -->

## Running

- **One instruction at a time:** a frame runs the instruction at its pc, which then moves to the next one, or to a label.
- **Charges:** each instruction's whole charge applies at it, so a Run that can't cover it has its Limit Fault at that instruction ([ADR 0010](../docs/adr/0010-normative-lowering-onto-a-stack-abstract-machine.md)).
- **Preemption** happens only between instructions ([chapter 5](05-handlers-messages-and-scheduling.md#fuel-slices)).
- **Suspension** happens only at an instruction marked "suspends". The Run resumes at the next instruction, with the instruction's result pushed.
- **Errors** are raised by an instruction, at its position in the source map ([below](#the-source-map)), and unwind as the Unwind Table says ([chapter 6](06-errors-and-limits.md)).
- **A frame's place,** for the Unwind Table and for cancellation, is the instruction it is running, the Suspension Point it is suspended at, or, for a caller, the call instruction it is waiting on. A preempted frame's place is the instruction it will run next.

### Calls

- **Calling a body:** `call`, `call-import`, `call-handler` and `call-value` pop their arguments and push a new frame for the callee's body, with the arguments in slots 1 on and every other local Nothing. The callee's `return` pops its result and its frame, and pushes the result onto the caller's stack.
- **Defaults:** a call to a function that passes fewer arguments than it has parameters fills each missing one from its default's definition ([ADR 0035](../docs/adr/0035-trailing-function-parameters-may-have-constant-defaults.md)). The loader has checked the count.
- **Handlers:** `call-handler` and `call-handler-wait`, like a Delivery, try the Handler's clauses in order. For each clause whose parameter count matches the argument count, it pushes a frame for the clause body and runs it. A clause body that reaches `clause-fail` is popped, and the next clause is tried. If none matches, `call-handler` raises `no match`, and a Delivery ends as `unhandled` ([chapter 5](05-handlers-messages-and-scheduling.md)). Each clause tried is charged at its body's first instruction ([Charging](#charging)).
- **Built-ins:** `call-builtin` runs the Built-in in place, with no frame, as one instruction. It fills missing arguments from the Built-in's defaults.
- **Function Values:** `call-value` checks, in order, that the value is a Function Value, that it isn't stale, that its Home Script is this Script, that it can't suspend and that it takes that many arguments ([chapter 4](04-expressions-and-statements.md#calls)). `call-value-wait` makes the same local call, suspending if the body does, or sends a foreign call to the Home Script and waits for its reply.
- **Lambdas:** a Lambda body's frame has its captured values in its capture slots, from the Function Value.
- **Call depth:** a call that would pass the call depth limit is a Limit Fault at the call ([chapter 6](06-errors-and-limits.md)).

## The lowering

A body's code is the lowering of its statements, in order, followed by `const nothing` and `return`, whether or not that end is reachable. Nothing is optimised at this level: every construct lowers to the instructions below, in the order below ([ADR 0010](../docs/adr/0010-normative-lowering-onto-a-stack-abstract-machine.md)).

In the rules, ⟦e⟧ is the lowering of `e`. For an expression, it pushes one value. For a statement, it leaves the stack as it found it. `t`, `t1`, … are temps, and `L`, `L1`, … are labels. Each instruction's position is the construct's, as [the source map](#the-source-map) says.

### Expressions

| Construct | Lowers to |
| --- | --- |
| a number, a Quantity, a text, `true`, `false`, `nothing` | `const` of it |
| a Built-in Constant, e.g. `pi` | `const pi` |
| `it` | `load 0` |
| `me`, `the target` | `me`, `target` |
| a local, or a captured local | `load` of its slot |
| a Script Variable | `load-var` |
| a Constant, the unit's or imported | `load-definition` |
| a function's bare name | `make-function`, or `make-imported-function` |
| a well-known object or Script name | `load-object` |
| `(e)` | ⟦e⟧ |
| `a op b`, for a binary operator | ⟦a⟧ ⟦b⟧, then the operator's instruction, with `fold` after `ignoring case` |
| `a is b`, `a is not b` | ⟦a⟧ ⟦b⟧ `equal`, or `not-equal` |
| `a is in b` | ⟦a⟧ ⟦b⟧ `member`, then `not` for `is not in` |
| `a is a K`, `a is empty` | ⟦a⟧ `is-kind K`, or `is-empty`, then `not` for `is not` |
| `a can be K` | ⟦a⟧ `can-convert K` |
| `a as K` | ⟦a⟧ `convert K` |
| `not a`, `-a` | ⟦a⟧ `not`, or `negate` |
| `a and b` | ⟦a⟧ `branch-false L1` ⟦b⟧ `check-boolean` `jump L2`, L1: `const false`, L2: |
| `a or b` | ⟦a⟧ `branch-true L1` ⟦b⟧ `check-boolean` `jump L2`, L1: `const true`, L2: |
| `the k of x`, `x's k` | ⟦x⟧ `get-key k` |
| `the (k) of x` | ⟦k⟧ ⟦x⟧ `get-key-computed` |
| `the p of x`, for a Built-in property | ⟦x⟧ `property p`, or ⟦x⟧ ⟦d⟧ `property-delimited p` with `delimited by d` |
| a Chunk Expression | [below](#chunk-expressions) |
| `[a, b, …]` | ⟦a⟧ ⟦b⟧ … `list n` |
| a list with a `...` item | `list 0`, then for each item ⟦item⟧ `list-append`, or ⟦e⟧ `list-extend` for `...e` |
| `{k1: a, k2: b, …}` | ⟦a⟧ ⟦b⟧ … `map` of the key list's constant and `n` |
| a Text Pattern with no splices | `const` of it |
| a Text Pattern with splices | ⟦s1⟧ ⟦s2⟧ … `make-pattern` of its template and `n` |
| `<< f1, f2, … >>` | `const <<>>`, then for each field ⟦value⟧ `bytes-field` of its type, for each `v as n bytes` field ⟦v⟧ ⟦n⟧ `bytes-sized` of its size unit, and for each run of bit fields ⟦v1⟧ … `bytes-bits` of its widths and `n` |
| `every match of p in s` | ⟦p⟧ ⟦s⟧ `match-all` |
| `replace p in s with e` | ⟦p⟧ ⟦s⟧ then [the replacement loop](#replace) |
| `f(a, …)`, and Lambdas | [below](#calls-lambdas-and-function-values) |

- **Ordinals** lower as their index: `first` is `const 1`, …, `tenth` is `const 10`, and `last` is `const -1`.
- **Negative literals** are the literal and `negate`, so `-5` is `const 5` `negate`.
- **A field's type** in `bytes-field` is `value` when the field has no `as`, and otherwise its integer type and byte order (`uint16 little`). In `bytes-sized` it is its size unit, `bytes` or `bytes as text`, and ⟦n⟧ is the `load` of a pinned name, or ⟦size⟧, as in a Binary Pattern.

### Chunk Expressions

A chain `k1 i1 of k2 i2 of … of x`, with an optional `delimited by d`, lowers to:

1. ⟦i1⟧ ⟦i2⟧ …, the outermost level's index first, as the source has them,
2. ⟦x⟧,
3. with `delimited by d`: ⟦d⟧ `store t`,
4. then, from the innermost level out, `chunk-get` of its kind, or `load t` `chunk-get-delimited item` for an `item` level with a delimiter.

The temp is released at the end. A plural chunk word lowers as its singular.

### Calls, Lambdas and Function Values

| Construct | Lowers to |
| --- | --- |
| `f(a, …)`, `f` a function of the unit | ⟦a⟧ … `call f n` |
| `f(a, …)`, `f` imported | ⟦a⟧ … `call-import`, or `call-handler` for a Handler |
| `h(a, …)`, `h` a Handler of the unit | ⟦a⟧ … `call-handler h n` |
| `f(a, …)`, `f` a variable | `load` of `f`, ⟦a⟧ … `call-value n` |
| `f(a, …)`, `f` a Built-in | ⟦a⟧ … `call-builtin f n` |
| a Lambda | the `load` of each captured local, in capture order, then `make-closure` of its body and the capture count |

- **Resolving `f`:** a call's name resolves as [chapter 4](04-expressions-and-statements.md#resolving-a-name) says, and only a name that resolves to nothing else is a Built-in, since a Script's names shadow Built-ins.
- **A Lambda's captures** are the locals of the enclosing body that the Lambda's code names, in the order it first names them, including names its own nested Lambdas capture. They are loaded when the Lambda is evaluated.
- **A Lambda's body:** its parameter patterns, bound directly, then ⟦e⟧ `return` for `given …: e`, or its block and then `const nothing` `return` for a block Lambda. With parameter patterns, F: `raise no match` comes last.

### Destructuring

A pattern tests the value in a slot `s`, and jumps to a fail label `F`.

| Pattern | Lowers to |
| --- | --- |
| a name `n` | `load s`, then `store` of `n`'s binding |
| `_` | nothing |
| `p as n` | the test of `p`, then `load s` and `store` of `n`'s binding |
| a literal `v` | `load s` `test-constant v F`, with `fold` under `match … ignoring case` |
| `^n` | `load s`, the `load` of `n`, `test-equal F` |
| `[p1, …, pk]` | `load s` `test-list k F`, then for each item `load s` `list-item i` and its sub-pattern |
| `[p1, …, pk, ...r]` | `load s` `test-list-at-least k F`, the items as above, then `load s` `list-rest k+1`, and the `store` of `r`'s binding, or `pop` for a bare `...` |
| `{k1: p1, …}` | `load s` `test-map F`, then for each entry `load s` `map-get k F` and its sub-pattern |
| a Text Pattern | `load s`, ⟦the pattern⟧, `match-whole F`, then for each Capture the literal writes, `load t` `get-key name` and its binding, with the Captures map in `t`, or `pop` if there are none |
| a Binary Pattern | [below](#binary-patterns) |

- **Sub-patterns:** a sub-pattern's value is on the stack. A name binds it straight away, `_` pops it, and anything else stores it in a temp and tests that temp, releasing it after.
- **Bindings:** in a Handler Clause, a Lambda or an event test, the body's frame is new, so a name's binding is its own slot. Everywhere else, each name binds to a new temp. When the whole pattern and its Guard have passed, `move` copies each temp into the name's slot, in binding order, and releases it, so a failed pattern binds nothing ([chapter 4](04-expressions-and-statements.md#destructuring)).
- **A Guard** that reads a pattern's names reads their temps.
- **Map shorthand:** `{name}` is `{name: name}`.

#### Binary Patterns

`load s` `bin-start F`, then for each field in order:

- a literal: `bin-literal` of its bytes and `F`
- `n: intType [order]`: `bin-int` of its type and `F`, then `n`'s binding, or `pop` for `_`
- a run of bit fields: `bin-bits` of their widths, their count and `F`, then their bindings, last field first
- `n: size bytes [as text]`: the size (the `load` of a pinned name, or ⟦size⟧), then `bin-bytes` of `bytes` or `bytes as text` and `F`, then `n`'s binding
- `...` or `...r [as text]`: `bin-rest` and `F`, then `r`'s binding, or `pop`, and nothing after it

and, unless the pattern ended in `...`, `bin-end F`. A name bound by an earlier field binds as the field is read, so a later size can read it: from the name's temp where the pattern binds to temps.

### Containers

A write into a Container rooted in a name, with levels `l1` (next to the root) to `lk` (the leaf), lowers to one store to the root ([ADR 0010](../docs/adr/0010-normative-lowering-onto-a-stack-abstract-machine.md)):

1. Anything the statement evaluates before the Container, such as the value in `put e into c`, into a temp `v`.
2. Each level's index or computed key, from `lk` back to `l1`, as the source has them, each into a temp.
3. The delimiter of `delimited by`, if any, into a temp.
4. The root's value, with its `load`, into a temp `w0`, then each level's whole down to `lk-1`: its index or key temp, `load w(i-1)`, its `chunk-get` or `get-key`, into a temp `wi`.
5. The write, from `l1` out to the leaf: for each level, its index or key temp and `load w(i-1)`, then the next level's write, or at the leaf the new part, then its `chunk-set` or `set-key`, or for an `item` level with a delimiter, `load` of the delimiter's temp and `chunk-set-delimited`.
6. The `store` of the root, and every temp is released.

The new part depends on the statement:

| Statement | The new part |
| --- | --- |
| `put e into c` | `load v` |
| `put e after c`, `put e before c` | the leaf's old value, `load v`, `append` or `prepend` |
| `put ...e after c`, `before c` | the same, with `append-all` or `prepend-all` |
| `add e to c`, `subtract e from c` | the leaf's old value, `load v`, `add` or `subtract` |
| `multiply c by e`, `divide c by e` | the leaf's old value, then ⟦e⟧ into `v` and `load v`, then `multiply` or `divide` |
| `replace p in c with e` | `load v` (holding ⟦p⟧), the leaf's old value, then [the replacement loop](#replace) |

The leaf's old value is its index or key temp, the whole above it and its `chunk-get` or `get-key`. A Container that is only a name skips steps 2 to 5, and its old value is its `load`: `add e to x` is ⟦e⟧ `store v`, the `load` of `x`, `load v`, `add` and the `store` of `x`. `put e into x` needs no temp: it is ⟦e⟧ and the `store` of `x`.

- **`delete c`** of a chunk or key is the write above for the Container one level up, with the chain's delimiter. The leaf's index or computed key is evaluated first, into a temp, as step 1. In step 4 every level, the last included, is first tested with `test-chunk`, `test-chunk-delimited`, `test-key` or `test-key-computed`, which jump to a label S after the root's `store` when the level isn't there, so nothing changes ([chapter 4](04-expressions-and-statements.md#delete)). The new part is `load` of the leaf's index temp, `load` of the last level's whole, then ⟦d⟧ for an `item` with `delimited by d`, and `chunk-delete`, `chunk-delete-delimited`, `delete-key` or `delete-key-computed`. `delete x` of a name is `const nothing` and its `store`.
- **`set the k of o to e`** is ⟦o⟧ ⟦e⟧ `set-property k`, and `set the (k) of o to e` is ⟦k⟧ ⟦o⟧ ⟦e⟧ `set-property-computed`.

#### `replace`

With the pattern and the text on the stack: `replace-start` of 1 for `replace first`, and 0 otherwise. Then L1: `replace-next L2` `store t`, then for each Capture the pattern's literal writes, `load t` `get-key captures` `get-key name` and the `store` of the name, then ⟦e⟧ `replace-put` `jump L1`, and L2: `replace-end`. The temp is released after the Captures.

### Statements

| Statement | Lowers to |
| --- | --- |
| `let p be e` | ⟦e⟧ `store t`, the pattern's test of `t` with temp bindings, the `move`s, `jump L2`, F: `raise no match`, L2: |

| `if c then a else b` | ⟦c⟧ `branch-false L1` ⟦a⟧ `jump L2`, L1: ⟦b⟧, L2:. Each `else if` is another arm before the `else` |
| `repeat for each p in e` | ⟦e⟧ `iterate`, L1: `next L2`, then the `store` of `p`'s name, or `store t`, the pattern's test of `t` with temp bindings, the `move`s, `jump L3`, F: `raise no match`, L3:, then the body, `jump L1`, L2: `pop` |
| `repeat e times` | ⟦e⟧ `iterate-times`, L1: `next L2` `pop`, the body, `jump L1`, L2: `pop` |
| `repeat while c` | L1: ⟦c⟧ `branch-false L2`, the body, `jump L1`, L2: |
| `repeat until c` | L1: ⟦c⟧ `branch-true L2`, the body, `jump L1`, L2: |
| `repeat forever` | L1: the body, `jump L1`, L2: |
| `exit repeat`, `next repeat` | any `finally` blocks it leaves, innermost first, then `jump` to the loop's L2, or L1 |
| `match e` | [below](#match) |
| `try` | [below](#try) |
| `throw e` | ⟦e⟧ `throw` |
| `return e` | ⟦e⟧, or `const nothing`; with `finally` blocks open, `store t`, those blocks innermost first, `load t`; then `return` |
| `veto e` | as `return e`, with `veto` in place of `return` |
| `pass m` | with `finally` blocks open, those blocks innermost first; then `pass m` |
| a Command Call `h a, …` | ⟦a⟧ … `call-handler h n` `store 0`, or `call-handler-wait h n` `store 0` with `and wait`. With no such Handler, `send-up h n`, or `send-up-wait h n` `store 0` with `and wait` |
| a call statement `f(a)` | the call, `call-value-wait` in place of `call-value` with `and wait`, then `store 0` |
| `ask g to op a, …` | ⟦a⟧ … `ask`, or `ask-wait` with `and wait`, then `store 0`, or `join-ask` in a Join |
| `tell g to op a, …` | ⟦a⟧ … `tell` |
| `say e` | ⟦e⟧ `tell console write 1` |
| `send m with a, … to r` | ⟦a⟧ … ⟦r⟧ `send`, or `send-wait` `store 0`, or `join-send` in a Join |
| `wait d` | ⟦d⟧ `wait` |
| `wait for …` | [below](#waiting) |
| `wait for all … end wait` | `join-start`, the body, `join-end` `store 0` |

- **`if`** jumps to L2 after every arm, except the last one when there is no `else`.
- **An iterator** stays on the stack below the loop's body, which leaves the stack as it found it, and L2 pops it.
- **`repeat for each`'s temp** is released after the `move`s, before the body.
- **Grants:** the name after `ask` or `tell` is a Grant, and the Operation's mode picks `ask`, `ask-wait` or `tell`, checked at load ([chapter 5](05-handlers-messages-and-scheduling.md)).

#### `match`

⟦e⟧ `store t`, then for each `when` branch, with F its own label:

1. A guard region: the pattern's test of `t`, with temp bindings, or for `when contains <p>`, `load t` ⟦p⟧ `match-search F` and its Captures, then the Guard.
2. The `move`s, the branch's body, `jump L`.
3. F:.

Then the `else` body, if any, and L:. `ignoring case` on the subject adds `fold` to each test. The temp is released at the end.

#### `try`

`try` with a body, catch clauses and a `finally` block lowers to:

1. The body, then a copy of the `finally` block, then `jump L`.
2. With catch clauses, the catch handler: `store t` of the error, then for each clause, with F its own label: a guard region of its pattern's test of `t` with temp bindings, and its Guard, then the `move`s, its body, a copy of the `finally` block and `jump L`, then F:. After the last clause, `load t` `rethrow`. A text literal head is the pattern `{code: "…"}`.
3. With a `finally` block, its cleanup copy: the `finally` block and `end-cleanup`.
4. L:.

A Handler ending in `finally` is this with no catch clauses around its body.

- **Its entries:** a `catch` entry for the body's instructions, targeting the catch handler, and a `finally` entry for the body's and the catch handler's instructions, targeting the cleanup copy ([The Unwind Table](#the-unwind-table)).
- **Copies are outside:** every copy of a `finally` block inlined by a `return`, `veto`, `pass`, `exit repeat` or `next repeat`, or on the normal path, is outside the spans of that `try`'s entries and of every `try` inside it, together with the instructions that leave after it: its `jump`, or its `load t` and `return`. So an error in a copy isn't caught by them, and a Run cancelled there doesn't run the block again. The catch handler's first `store t` is outside the `finally` entry too. An entry whose instructions are split this way is several entries, one per span, in order.
- **Leaving a `finally` block:** a `return`, `veto` or `pass` inside a `finally` block, or an `exit repeat` or `next repeat` whose loop is outside it, is a load error ([chapter 6](06-errors-and-limits.md#finally)).

#### Waiting

- **`wait for m p… [from x] [or d]`:** ⟦x⟧, the `load` of each local the event's test captures, then ⟦d⟧, then `wait-for` of its event entry, then `store 0`.
- **The block form:** for each branch in order, ⟦x⟧ and its captures for a `when`, or ⟦d⟧ for an `after`, then `wait-for-any` of its entry, then `store t` of the branch number and `store 0` of the message. Then for each branch, numbered from 1, with F its own label: `load t` `const i` `equal` `branch-false F`, the branch's body, `jump L`, F:. And L:.
- **Bindings:** when an event matches, the Core writes the values its test gives into the slots its entry lists, then resumes.

### Handler Clauses

A Handler Clause's body lowers to:

1. **A guard region:** each parameter pattern that isn't a plain name, tested against its argument's slot and bound directly, then the Guard with a failure going to F.
2. The body, or its `try` with its `finally` block.
3. `const nothing` `return`, then F: `clause-fail`.

A function's body is its statements, then `const nothing` `return`. Its parameters are plain names.

### Guards

A Guard lowers to ⟦g⟧ `branch-false F`. In a Handler Clause, a `match` branch, a `catch` clause or an event test, the pattern's tests and the Guard are one guard region, a `guard` entry targeting F. So an error while testing, a Guard that gives something other than a boolean, or an error in the Guard, skips the clause, and `try` never sees it ([chapter 4](04-expressions-and-statements.md#guards)).

## The Unwind Table

Each code unit has one Unwind Table, whose entries are part of its disassembly ([ADR 0017](../docs/adr/0017-errors-are-plain-maps-raised-with-throw-and-caught-by-destructuring.md)).

- **An entry** gives a range of instructions, a kind (`catch`, `finally` or `guard`), a target and a depth: the number of loop iterators on the operand stack there, one for each `repeat for each` or `repeat … times` around it in the body. That is the stack's depth wherever the range starts, reachable or not.
- **Order:** entries are grouped by body, in body order. Within a body, they are listed in the order the lowering makes them: a `catch` entry as its catch handler begins, a `guard` entry as its region ends, and a `finally` entry after its catch handler. So an inner construct's entries come before the outer one's.
- **Lookup:** an error raised at an instruction goes to the first entry whose range holds it, in the frame that raised it. The operand stack is cut to the entry's depth, and the frame continues at the target:
  - **`catch`:** with the error pushed.
  - **`finally`:** with the error on the Run's cleanup stack. The `end-cleanup` at the copy's end raises it again, and an error raised in the copy replaces it, with the old one as `during` ([chapter 6](06-errors-and-limits.md)).
  - **`guard`:** with nothing, so the clause or branch fails.
- **No entry:** the frame is popped, and unwinding goes on at the caller's call instruction. Unwinding is charged per frame popped.
- **Cancellation** runs each `finally` entry's cleanup copy whose range holds a frame's pc, innermost first, with the cancellation on the cleanup stack ([chapter 6](06-errors-and-limits.md#cancellation-and-stop)). It isn't unwinding: it charges no `unwind`, and a frame with no `finally` entry left to run is dropped, not popped by an error.
- **Entering a `try`** costs nothing, since it has no instruction.

## The event table

Each `wait for` has an entry. For each branch, a `when` entry gives its message, whether it has `from`, its test body, its number of captures and the slots it binds. An `after` entry is just a duration. A `wait for … or d` has a timeout.

- **The values `wait-for` pops,** deepest first: for each branch in order, the `from` object and the captured values of a `when`, or the duration of an `after`, then the timeout.
- **A test body** is a body of kind `event`. Its arguments are the message's arguments, and its captures are in its capture slots. It tests the event's patterns and Guard as one guard region, pushes the values of the names they bind, in order, then `list n` and `return`. A failure reaches `clause-fail`. An event with no patterns and no Guard has no test body.
- **Matching** is chapter 5's ([chapter 5](05-handlers-messages-and-scheduling.md)). The Core runs a pending `wait for`'s test body when a message is dispatched, charging it to the waiting Run.

## The canonical disassembly

Each Core prints a code unit in one canonical text, which a Disassembly Case pins ([chapter 11](11-the-trace-and-conformance.md)). It is a series of sections, in order, each a heading line and then indented lines, and a section with nothing in it is left out:

```text
unit <name> <script or library>
constants
  <index> <constant in the display form>
definitions
  <index> <name, or library:name, or function.parameter>
variables
  <index> <name>
objects
  <index> <name>
bodies
  <index> <kind> <name> [clause <n>] (<parameters>) [captures <n>] locals <n> [may suspend] <first>..<last>
code
  <pc> <line>:<column> <instruction> <operands> [; <note>]
unwind
  <first>..<last> <kind> -> <target> depth <n>
events
  <index> <branch>; <branch>…[; or]
```

- **Spacing:** the fields of a line are separated by one space, with no padding, as in `  0004 2:9 add` and `  0005 2:3 store 3 ; total`.
- **Numbers:** an instruction index is four digits or more, padded with zeros. A parameter with a default is `name = <definition index>`, and a pattern parameter is `…`.
- **Operands** are shown as their operand kind says. A `constant`, `local`, `variable` or `body` operand is its number, and a `label` an instruction index. A `key` is text in the display form, as in `get-key "unit price"`. Every other operand is its name, as written: `load-definition rate`, `load-object door`, `call-import list:sortBy 2`, `is-kind civil date`, `raise no match`.
- **Notes** after `;` name what each `constant`, `local`, `variable` and `body` operand refers to, in operand order, separated by `, `: the constant in the display form, the local's or Script Variable's name, or the body's name, as in `move 13 3 ; (13), a`. They are part of the canonical text, and a line with no such operand has none. A temp's name is its slot in parentheses, `(12)`, and so is the argument slot of a pattern parameter.
- **Events:** a `when` branch is `when <message>`, then `from`, `body <index>`, `captures <n>` and `binds <slot>, <slot>…`, each only where it applies, and an `after` branch is `after`. A `wait for … or d` ends with `; or`.
- **Line ends** are LF, and the text ends with one.

## The source map

Each instruction has a source position, the second column of its disassembly line ([chapter 1](01-lexical-structure.md#source-text)). It is the position of the construct whose lowering emits it, where ⟦e⟧'s instructions are `e`'s own, and everything else a rule emits (its jumps, `store`s, `move`s, `pop`s and tests) is the construct's the rule is for. A construct's position is:

- for an operator, the operator's token, such as the `+` of `a + b`, and for `not` and unary `-`, that token
- for a literal or a name, its token, for a list, a map or a build, its opening bracket, and for a Chunk Expression, its chunk word
- for a key, its `the` or `'s`, and for a call, the function's name
- for a statement, its first token, for a `when`, `catch` or `wait for` branch, its first word, and for a Guard, its first token
- for a Container write, each level's instructions (its index's `store`, its test, its read and its write) are that level's, and the value's `store`, the root's `load` and the root's `store` are the statement's
- for a pattern, its first token, and for a Binary Pattern field, the field's first token
- for a Lambda, `given`
- for a body's closing `const nothing` and `return`, the `end` that closes it, or line 1, column 1 in the initialiser. A clause's `clause-fail` has the same position

Some rules emit instructions for constructs the list doesn't place. Their positions are:

- **Declarations:** a Script Variable's `store-var` and a Constant's `store-definition` are the declaration's first token, and a parameter default's `store-definition` its parameter's name.
- **`try`:** the `try`'s own instructions (the `jump` after its body, the catch handler's `store t`, its `load t` and `rethrow`, and `end-cleanup`) are its `try`, or its `finally` for a Handler that ends in one. A `catch` clause's `move`s and `jump` are its `catch`.
- **Patterns:** a list or map pattern's `load s`, `list-item`, `list-rest` and `map-get` are that pattern's. A sub-pattern's own `store` or `pop`, the `store` of a name or `_` included, is the sub-pattern's.
- **Chunks:** a `delimited by`'s `store t` is the outermost level's chunk word, and an ordinal's `const` its level's chunk word.
- **Lambdas:** a `given …: e`'s `return`, and a Lambda's `raise no match`, are its `given`.
- **Waiting:** an event test's own instructions (its bindings' `load`s, `list`, `return` and `clause-fail`), the `load`s of its captures, and a block `wait for` branch's `load t` `const i` `equal` `branch-false` and `jump`, are the branch's first word, or the `wait` of a one-line `wait for`.
- **Builds:** a field's `bytes-field` or `bytes-sized`, and a run of bit fields' `bytes-bits`, are the first token of the field, or of the run's first field.
- **Loops:** `repeat for each`'s `store` of a plain name is its `repeat`.

An error's `at` and the debugger's breakpoints both read it ([chapter 6](06-errors-and-limits.md#errors)). Inside the stdlib, `at` is the Script's call instead ([ADR 0037](../docs/adr/0037-errors-raised-in-stdlib-code-point-at-the-scripts-call.md)).

> **Note.** [`tools/machine/`](../tools/machine/check.ts) holds a compiler that follows this chapter. `bun run machine:check` lowers the stdlib, the syntax sketch, the corpus and every `talk` block in `docs/` and `spec/`. It checks every instruction against `machine.toml`: each exists, with its operands, and every path through a body reaches each instruction with one stack depth and ends in an instruction that leaves the body. It also compiles every Text Pattern it reads to a program, and runs a table of patterns whose matches and steps this chapter's rules fix. `bun tools/machine/check.ts --dis FILE` prints a file's canonical disassembly. Like all tooling, it isn't normative ([ADR 0028](../docs/adr/0028-tooling-is-one-ts-stack-and-nothing-it-produces-is-normative.md)).

## Text Pattern programs

A Text Pattern compiles to a program for one linear-time matcher, a Pike VM, that runs the same on both Cores and never on a Host's regex engine ([ADR 0007](../docs/adr/0007-text-patterns-are-linear-time.md)). The program and the way the matcher's thread list evolves are normative, since matching Fuel counts the matcher's threads ([ADR 0010](../docs/adr/0010-normative-lowering-onto-a-stack-abstract-machine.md)). A Core may run a different matcher, as long as it gives the same matches and the same `steps`.

### The program

A program is a list of instructions, numbered from 0, and its size is the `program` measure. It works over Characters: a position is between two, from 0 before the first to `n` after the last.

| Instruction | Does |
| --- | --- |
| `char c` | matches one Character equal to `c` |
| `char c fold` | matches one Character whose simple case folding equals `c`'s |
| `class k` | matches one Character in the class `k`: `any`, `digit`, `letter`, `uppercase`, `lowercase`, `punctuation`, `whitespace` or `nonspace` |
| `split a b` | continues at `a`, and at `b` with less priority |
| `jump a` | continues at `a` |
| `save n` | records the position in capture slot `n` |
| `assert k` | continues only if the anchor `k` holds at the position |
| `match` | the pattern has matched |

A class holds a Character when its first scalar does, as [chapter 4](04-expressions-and-statements.md#elements) says. `digit` is exactly one of `0` to `9`, and `nonspace` is a Character that isn't White_Space.

### Compiling

A pattern's program is the code of its elements in order, then `match`. In the rules, `P` is the code for `p`, and `L`, `E` are the instruction numbers the code reaches:

| Element | Compiles to |
| --- | --- |
| a text literal | one `char` per Character, `char … fold` under `ignoring case` |
| `character`, `digit`, `letter`, `punctuation`, `whitespace` | `class any`, `class digit`, `class letter`, `class punctuation`, `class whitespace` |
| `uppercase letter`, `lowercase letter` | `class uppercase`, `class lowercase` |
| `space` | `char " "` |
| `word` | one or more of `class nonspace` |
| `characters`, `digits`, `letters`, `spaces`, `uppercase letters`, `lowercase letters` | one or more of the singular's code |
| `words` | `word`, then zero or more of: one or more of `class whitespace`, then `word` |
| `text` | zero or more of `class any` |
| `a number` | optional `char "-"`, one or more of `class digit`, then optional: `char "."` and one or more of `class digit` |
| `one or more of p` | L: P, `split L E`, E: |
| `zero or more of p` | L: `split L+1 E`, P, `jump L`, E: |
| `optional p` | L: `split L+1 E`, P, E: |
| `p or q` | L: `split L+1 M`, P, `jump E`, M: Q, E: |
| `n p` | P, `n` times. For a plural keyword, `n` copies of its singular, and for `words`, `word`, then `n - 1` times one or more of `class whitespace` and `word` |
| `<p, q, …>` | P, Q, … |
| `name: p` | `save 2i`, P, `save 2i+1`, where `i` counts the pattern's Captures from 0, in order |
| an anchor | `assert` of it |
| `(e)`, a spliced pattern | its elements' code, with its Captures numbered on from the ones before |
| `(e)`, spliced text | the code of a literal of it |

- **Lazily:** `lazily` swaps the two targets of each `split` the element's own repetition makes, so it prefers to match less: `one or more of p lazily` is L: P, `split E L`, E:. The element's own repetition is its `one or more of`, `zero or more of` or `optional`, or every repetition in a plural keyword's, `text`'s or `words`'s code. On a Capture it applies to the Capture's element. It doesn't reach the elements inside a nested `<…>`, a repetition or an `or`.
- **When:** a pattern with no splices compiles when its code unit loads, as a constant. One with splices compiles at its `make-pattern`, which charges for it by the program's size.
- **Conversions** (`as number`, `a number`'s value) aren't code. They are done to the Captures after the match.
- **Size:** a program over the Text Pattern size limit fails as [chapter 6](06-errors-and-limits.md#limits) says. A pattern's logical size counts its program ([Logical sizes](#logical-sizes)).

> **Example.** `<"$", digits>` compiles to `0 char "$"`, `1 class digit`, `2 split 1 3`, `3 match`, a program of size 4. `<"$", digits lazily>` has `2 split 3 1` instead.

### Running

A run matches a program against the Characters of a text from a start position, and counts `steps`. It keeps a list of threads in priority order, each an instruction number and its capture slots, and a set of the instruction numbers already added at the current position.

- **Adding a thread** at an instruction and position: if the instruction was already added at this position, nothing happens. Otherwise it is marked, and:
  - `jump a` adds at `a`, and `split a b` adds at `a` then at `b`
  - `save n` adds at the next instruction, with slot `n` set to the position
  - `assert k` adds at the next instruction if `k` holds, and otherwise nothing
  - `char`, `class` and `match` are appended to the list
- **At each position,** from the start position up:
  1. **Seeding:** if the run seeds here, a new thread is added at instruction 0, with empty slots, after the threads already in the list.
  2. **Steps:** the number of threads in the list is added to `steps`.
  3. **Stepping:** each thread, in order, at a `char` or `class` that the Character at this position satisfies, adds a thread at its next instruction, at the next position, to a new list, with a new set of marks. A thread at `match` is a match, if the run accepts one here: it is recorded, and the threads after it in the list are dropped, since each is less preferred. A run that only needs to know a match exists stops at the first one.
  4. **Ending:** the new list and its marks become the current ones, for the next position. The run ends after position `n`, or when the list is empty and the run no longer seeds, or has recorded a match.
- **The match** a run gives is the last one it recorded, with its start (the position its thread was seeded at), its end and its capture slots. A capture slot never set took no part.

Each operation runs one of four kinds of run:

| Run | Seeds | Accepts a match | Used by |
| --- | --- | --- | --- |
| whole | at the start only | at the end only | `matches`, `match-whole` |
| search | at every position, until a match is recorded | anywhere | `contains`, `match-search`, `offset`, the Match Search |
| prefix | at the start only | anywhere | `begins with` |
| suffix | at every position, until a match is recorded | at the end only | `ends with` |

- **Stopping at the first match:** `matches`, `contains`, `begins with` and `ends with` need only a boolean, so they stop at the first match recorded. The others run to the end, since a later thread may be more preferred.
- **A text needle** is run as the program of a literal of it.
- **A Bytes needle** in a search of Bytes is run the same way over the bytes, one position per byte, with a `char` for each byte of the needle.
- **The Match Search** (`match-all`, `replace-start`, and the stdlib searches over it) runs searches one after another, each from where the last match ended. A search whose match is empty and starts where the last match ended is discarded, whether the last match was empty or not, and the next search starts one Character later. The Match Search stops when a search records no match, or when the next search would start past the end of the text. `steps` sums every search, the discarded ones included.
- **Captures:** a Match's `captures` and `ranges` come from the capture slots, and each Capture's conversion, such as `as number`, happens after the match, in Capture order.

> **Example.** `<"$", digits>` searching `"$895"`: at position 0 the list is the seed at `char "$"`, 1 step. At 1, it is `class digit` then a new seed at `char "$"`, 2 steps, and so on, with the match recorded at position 4, where its thread is first. The search counts 10 steps and gives `"$895"`, the greedy match. With `lazily`, the match at position 2 comes first, and it gives `"$8"` after 6 steps.

## The Cost Model

The Cost Model says how much Fuel and allocation each instruction is charged, and how large each value counts as ([ADR 0006](../docs/adr/0006-limit-faults-roll-back-the-segment.md), [ADR 0010](../docs/adr/0010-normative-lowering-onto-a-stack-abstract-machine.md)). It is [`costs.toml`](data/costs.toml), versioned on its own: a change to a rate, a size or the lowering is a new Cost Model version, and re-blesses the corpus ([chapter 0](00-introduction.md#versions)).

> **Note.** Cost Model 0 is provisional. Its rates keep a simple instruction at about 1 Fuel and scale bulk work by its size, but they aren't measured. Cost Model 1 is calibrated against both Cores once they pass the seed corpus ([Appendix C](appendix-c-handed-off-open.md)).

### Charging

- **At the instruction:** each instruction is charged its key's Fuel formula and its allocation formula, together, when it runs, with every measure taken from the values it works on. If either takes the Run past its limit, the Run has a Limit Fault at that instruction, before it does anything ([chapter 6](06-errors-and-limits.md#limit-faults)).
- **Its own limit first:** an instruction that has a limit of its own checks it before its charge: a call checks the call depth, `make-pattern` the Text Pattern size, and `join-ask` and `join-send` `MaxJoin`. One that passes it faults on that limit, and is never charged. So `make-pattern` compiles its program and measures it, and is charged by its size only when it fits.
- **Fuel next:** Fuel is checked before allocation, so a Run past both faults on Fuel.
- **A Built-in** is charged by its own rate, `builtin.<name>`, in place of `call-builtin`'s key.
- **Dispatch** charges the `clause` rate for each Handler Clause it tries, at the clause body's first instruction, added to that instruction's own charge. So a Run that can't pay for a clause faults at that instruction, with its position, and the clause is never tried. This holds for a Delivery's dispatch and for `call-handler` and `call-handler-wait` ([chapter 5](05-handlers-messages-and-scheduling.md)).
- **Unwinding** charges the `unwind` rate at the instruction that raised, for the frames it pops, before any of them is popped ([chapter 6](06-errors-and-limits.md)). A cancellation unwinds nothing, so it charges no `unwind` ([below](#the-unwind-table)).
- **A Capability call** charges the Operation's declared cost, which the Host sets, through `declared`, plus the conversion of its result. A Host function may charge more through its budget handle before it does the work ([chapter 9](09-embedding.md)).
- **A late answer:** an answer to a suspending call, or a Join member's answer, is charged when the Run resumes, in start order, by the rate of the instruction that waited: only its terms over `result`, since the rest was charged at the call, plus any cost that came with the answer. So a reply to `send … and wait` and the end of a `wait` charge nothing more.
- **Cleanup:** a cancelled Run's `finally` blocks are charged as any code is, but to its Cleanup Budget, not to its Fuel ([chapter 6](06-errors-and-limits.md#cancellation-and-stop)).
- **Not charged:** loading a code unit and running its initialiser, NFC when a Host builds a text value, and the Host's own work.
- **Fuel Slices** count the same Fuel ([chapter 5](05-handlers-messages-and-scheduling.md#fuel-slices)).

### Formulas

A formula is a sum of terms: a whole number, or a measure, optionally multiplied by a whole number before it and divided by one after it, as in `3 + characters(result) / 16 + 2 * items(input)`. Each divided term rounds up on its own, so `characters(result) / 16` is 1 for 1 to 16 Characters. A measure of a value that isn't there, such as the result of an instruction that pushes nothing, is 0.

<!-- generated: costs.measures -->

| Measure | Counts |
| --- | --- |
| `size` | the logical size of the value, as the [[size]] table gives it |
| `contents` | the sum of the logical sizes of the values the value holds: a list's items, a map's keys and values, a range's ends, a Function Value's captures |
| `characters` | the number of Characters, for text; 0 for any other value |
| `scalars` | the number of Unicode scalar values, for text; 0 for any other value |
| `utf8` | the length of the UTF-8 encoding, for text; 0 for any other value |
| `bytes` | the number of bytes, for Bytes; 0 for any other value |
| `items` | the number of items, for a list, and of integers, for an integer range; 0 for any other value |
| `entries` | the number of keys, for a map; 0 for any other value |
| `digits` | the number of digits in the coefficient, 1 for a zero, for a number or the number of a Quantity; 0 for any other value |
| `scanned` | what the instruction examines, as its rate's `input` says |
| `steps` | the Text Pattern matcher's steps: the threads in its list at each position, summed over the positions its runs reach (chapter 8, Running) |
| `program` | the number of instructions in a Text Pattern's compiled program (chapter 8, Compiling) |
| `frames` | the number of frames an unwinding pops |
| `clauses` | the number of Handler Clauses a dispatch tries |
| `count` | the instruction's `count` operand, or 0 if it has none |
| `declared` | the Operation Declaration's per-call cost, which the Host sets |

| Subject | Is |
| --- | --- |
| `input` | the value the instruction works on, as its rate's `input` says |
| `result` | the value the instruction pushes, or the first of them |
| `v` | the value being measured, in a [[size]] formula |
| `x1` | a Built-in's first argument, and x2, x3, … the others |

<!-- end -->

- **Text measures:** `characters` counts Characters, so it covers segmenting text, and `scalars` covers work done per code point, such as NFC and case folding.
- **`input` and `scanned`** mean what each rate's "Input" column says.
- **Arguments:** in a Built-in's rate, `x1`, `x2`, … are its arguments, in order, defaults included.

### Logical sizes

The Allocation Budget and Persistent State count values by their logical size, as if nothing were shared ([ADR 0001](../docs/adr/0001-value-semantics.md)), so a value held twice counts twice, and a Core's sharing is never visible.

<!-- generated: costs.sizes -->

| Of | Logical size |
| --- | --- |
| nothing | `8` |
| boolean | `8` |
| number | `16` |
| quantity | `24` |
| text | `16 + utf8(v)` |
| bytes | `16 + bytes(v)` |
| list | `16 + 8 * items(v) + contents(v)` |
| map | `16 + 8 * entries(v) + contents(v)` |
| range | `16 + contents(v)` |
| instant | `16` |
| civil date | `16` |
| pattern | `16 + 8 * program(v)` |
| function | `32 + 8 * items(v) + contents(v)` |
| object | `16` |
| iterator | `24 + size(v)` |
| replacement | `32 + contents(v)` |
| reader | `24 + size(v)` |
| frame | `64 + 8 * items(v) + contents(v)` |
| run | `96 + contents(v)` |
| message | `32 + contents(v)` |
| pending call | `48` |

<!-- end -->

- **Persistent State** is measured at each Segment's end, over everything the Script keeps ([chapter 6](06-errors-and-limits.md#limits)): each Script Variable's value, each message in its mailbox, and each suspended, parked or preempted Run, which counts its frames, its pending calls and its Join's early answers.
- **A frame's** `items` is its number of locals, and its `contents` the values in its locals and on its operand stack. A Run's `contents` is its frames and pending calls, and a message's its arguments.
- **An internal value** counts the value it holds as well: an iterator its list or range, a reader its Bytes, and a replacement its text and Matches.
- **The Allocation Budget** counts what each instruction's allocation formula says. An instruction that builds a value counts its size, and a write counts only the new part it puts in, not the whole it rebuilds ([ADR 0010](../docs/adr/0010-normative-lowering-onto-a-stack-abstract-machine.md)).

### Rates

<!-- generated: costs -->

Cost Model **0**.

| Cost Model key | Fuel | Allocation | Input |
| --- | --- | --- | --- |
| `const` | `1` | 0 |  |
| `stack` | `1` | 0 |  |
| `slot` | `1` | 0 |  |
| `store-var` | `2` | 0 |  |
| `jump` | `1` | 0 |  |
| `branch` | `1` | 0 |  |
| `operator` | `2` | `size(result)` |  |
| `arithmetic` | `3 + digits(result) / 8` | `size(result)` |  |
| `power` | `8 + 2 * digits(result)` | `size(result)` |  |
| `concat` | `3 + scalars(result) / 16` | `size(result)` |  |
| `compare` | `2 + scanned / 16` | 0 | the two operands; `scanned` is the pairs compared in order, through the first that differs or to the end of the shorter: Characters of text (their simple case foldings under `ignoring case`), bytes of Bytes, items of a list, or entries of a map in the left operand's order; 0 for any other kind, and between two kinds |
| `member` | `2 + scanned` | 0 | the list or range; `scanned` is the items compared, through the first equal one, or 2 for a range |
| `convert` | `4 + scalars(input) / 8 + scalars(result) / 8` | `size(result)` | the value converted |
| `search` | `4 + steps` | 0 | the text searched |
| `get-key` | `3` | 0 | the map or Host Object; a Host Object's property also charges the value's conversion, as a Capability result does |
| `property` | `3 + scalars(input) / 8 + items(result)` | `size(result)` | the value whose property is read |
| `chunk-get` | `3 + scanned / 8` | `size(result)` | the value read; `scanned` is the Characters or items from its start to the end of the chunk, code points for a `code point` chunk, and all of them when the chunk isn't there; `test-chunk` measures as a read of the chunk it tests |
| `chunk-set` | `4 + scalars(result) / 8 + items(result) / 8` | `size(input)` | the new part; the Fuel counts the whole rebuilt value, and the allocation only the new part (ADR 0010) |
| `set-key` | `4 + entries(result) / 16` | `8 + size(input)` | the new value |
| `append` | `3 + scalars(result) / 16` | `8 + size(input)` | the value appended |
| `set-property` | `10 + size(input) / 32` | 0 | the value set |
| `list` | `2 + count + items(result) / 16` | `size(result)` |  |
| `map` | `2 + 2 * count` | `size(result)` |  |
| `make-pattern` | `20 + 2 * program(result)` | `size(result)` |  |
| `bytes-field` | `3 + bytes(input) / 8` | `size(result)` | the field's value |
| `match` | `6 + steps` | `size(result)` | the text matched |
| `iterate` | `2` | `24` | an iterator shares its list or range, so only the iterator itself is new |
| `next` | `2` | 0 | the item is part of the snapshot the iterator shares, and a Match is part of the replacement, so nothing is new |
| `make-closure` | `4 + count` | `size(result)` |  |
| `call` | `8` | 0 |  |
| `clause` | `4` | 0 | each Handler Clause a dispatch tries, charged at the clause body's first instruction |
| `return` | `2` | 0 |  |
| `test` | `1` | 0 |  |
| `bin-field` | `2 + bytes(result) / 8 + scalars(result) / 8` | `size(result)` | `result` is the value the field reads, which `bin-literal` has none of; for `bin-bits` it is the run's values, and their sizes add |
| `throw` | `10` | `48` | the `at` map the Core adds, when it adds one |
| `unwind` | `4 * frames` | 0 |  |
| `capability` | `10 + declared + size(result) / 32` | `size(result)` | the Operation's result, converted into Script values |
| `send` | `20 + size(input) / 32` | `size(input)` | the message, whose size counts toward the receiver's mailbox |
| `wait` | `10` | 0 |  |
| `join` | `10` | `size(result)` |  |

<!-- end -->

### Built-in rates

Each Built-in has one rate ([ADR 0021](../docs/adr/0021-the-stdlib-is-a-small-built-in-core-plus-libraries-written-in-the-language.md)). The transcendental functions are charged a flat rate per call.

<!-- generated: costs.builtins -->

| Built-in | Fuel | Allocation | Input |
| --- | --- | --- | --- |
| `min` | `4 + scanned` | 0 | `scanned` is the items compared |
| `max` | `4 + scanned` | 0 | `scanned` is the items compared |
| `codePoint` | `3` | 0 |  |
| `fromCodePoint` | `4` | `size(result)` |  |
| `upper` | `4 + scalars(x1) / 4 + scalars(result) / 8` | `size(result)` |  |
| `lower` | `4 + scalars(x1) / 4 + scalars(result) / 8` | `size(result)` |  |
| `offset` | `4 + steps` | 0 |  |
| `isDisposed` | `2` | 0 |  |
| `rangeStart` | `2` | 0 |  |
| `rangeEnd` | `2` | 0 |  |
| `abs` | `3` | `size(result)` |  |
| `floor` | `3 + digits(x1) / 8` | `size(result)` |  |
| `ceiling` | `3 + digits(x1) / 8` | `size(result)` |  |
| `truncate` | `3 + digits(x1) / 8` | `size(result)` |  |
| `round` | `5 + digits(result) / 8` | `size(result)` |  |
| `sqrt` | `60` | `size(result)` |  |
| `exp` | `60` | `size(result)` |  |
| `ln` | `60` | `size(result)` |  |
| `log10` | `60` | `size(result)` |  |
| `power` | `60` | `size(result)` |  |
| `sin` | `60` | `size(result)` |  |
| `cos` | `60` | `size(result)` |  |
| `tan` | `60` | `size(result)` |  |
| `asin` | `60` | `size(result)` |  |
| `acos` | `60` | `size(result)` |  |
| `atan` | `60` | `size(result)` |  |
| `atan2` | `60` | `size(result)` |  |
| `fromFloat64` | `8` | `size(result)` |  |
| `fromFloat32` | `8` | `size(result)` |  |
| `toFloat64` | `8` | `size(result)` |  |
| `toFloat32` | `8` | `size(result)` |  |
| `year` | `3` | 0 |  |
| `month` | `3` | 0 |  |
| `day` | `3` | 0 |  |
| `hour` | `3` | 0 |  |
| `minute` | `3` | 0 |  |
| `second` | `3` | 0 |  |
| `nanosecond` | `3` | 0 |  |
| `weekday` | `4` | 0 |  |
| `dayOfYear` | `4` | 0 |  |
| `isoWeek` | `6` | 0 |  |
| `isoWeekYear` | `6` | 0 |  |
| `hasTime` | `2` | 0 |  |
| `toCivil` | `10` | `size(result)` |  |
| `toInstant` | `10` | `size(result)` |  |

<!-- end -->

### Changes to Cost Model 0

Cost Model 0 is provisional, so it changes in place, and each change is listed in [`costs.toml`](data/costs.toml). A change re-blesses every case blessed against it ([Appendix B](appendix-b-implementation-order.md#blessing-the-seed-corpus)). From Cost Model 1 on, a change is a new version.

<!-- generated: costs.changes -->

| Issue | Change |
| --- | --- |
| [#115](https://github.com/odogono/odgn-talk/issues/115) | `next` and `replace-next` move from the `iterate` key to a new `next` key, at 2 Fuel and no allocation, since neither builds a value; `iterate` charged 24 allocation on every pass |
| [#115](https://github.com/odogono/odgn-talk/issues/115) | Dispatch charges the `clause` rate at the first instruction of each clause body it tries, together with that instruction's own charge, so a fault there has an instruction and a position |
| [#115](https://github.com/odogono/odgn-talk/issues/115) | An instruction checks its own limit (call depth, Text Pattern size or `MaxJoin`) before its Fuel and allocation, so an instruction that passes one faults on it and is never charged |
| [#126](https://github.com/odogono/odgn-talk/issues/126) | The `compare`, `member` and `chunk-get` rates say exactly what `scanned` counts, `test-chunk` measures as the read it tests, and a zero's coefficient has 1 digit |

<!-- end -->

## Outside parity

- **Representation:** a Core's byte encoding, dispatch technique, value representation and any JIT ([ADR 0010](../docs/adr/0010-normative-lowering-onto-a-stack-abstract-machine.md)).
- **Fusion:** a Core may run several instructions as one only when the Fuel, the faulting instruction and a preemption opportunity at every boundary between them stay the same.
- **Pre-checks:** a Core may check a cheap bound before an instruction, or poll inside a long one, as long as the work it does stays proportional to the Fuel remaining.
