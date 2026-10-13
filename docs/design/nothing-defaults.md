# Design: Nothing defaults and optional map-key reads

For [#687](https://github.com/odogono/odgn-talk/issues/687), based on
`0ea3a15c`, 2026-10-13. The selected design is **`otherwise` plus optional
map-key reads**. The word spelling is selected for xTalk style, with its source-compatibility
cost accepted. `??` is not part of this design.

This design is integrated and active in language **1.0-rc.3**. The Spec is
normative: [chapter 4](../../spec/04-expressions-and-statements.md#nothing-defaults)
for behavior, [chapter 2](../../spec/02-grammar.md) and
[chapter 1](../../spec/01-lexical-structure.md) for grammar and continuation,
[chapter 6](../../spec/06-errors-and-limits.md#errors) for errors,
[chapter 8](../../spec/08-the-abstract-machine-and-the-cost-model.md) for
instructions, lowering and Fuel, and [chapter 0](../../spec/00-introduction.md#versions)
for the version. This file keeps the design rationale and the acceptance
groups the corpus covers. For migration, see the
[migration guide](../migrations/nothing-defaults.md). The
[exploration](../research/nothing-default-syntax.md) records alternatives.

## Behavior

```text
put the second of found otherwise 0 into seconds
put the optional city of the optional address of customer otherwise "unknown" into city
```

### Default expression

`a otherwise b` evaluates `a` exactly once. If its value is not Nothing,
that value is the result and `b` is not evaluated. If it is Nothing, evaluate
`b` once and return its value, including Nothing. False, zero, empty text,
empty lists and empty maps never trigger the fallback. Errors and Limit
Faults propagate normally; this operator does not catch them. It neither
calls the Host nor converts its operands, but evaluated operand expressions
may perform whatever their enclosing context permits.

The operator is left-associative and has lower precedence than `or`, hence
lower precedence than every existing ordinary binary operator:

```text
a otherwise b otherwise c       -- (a otherwise b) otherwise c
a + b otherwise 0               -- (a + b) otherwise 0
a otherwise b or c              -- a otherwise (b or c)
(a otherwise 0) > 3             -- default before comparing
```

Lambdas and Whose Clauses keep their whole-expression boundaries.
`given x: x otherwise d` defaults the Lambda's result.
`the first item of xs whose active otherwise false` defaults the condition.
To default the selection, write
`(the first item of xs whose active) otherwise fallback`.
A Lambda on either side needs the parentheses already required when using
one as a binary operand. Restricted grammar slots stay restricted: default
expressions in a replace expression's subject or replacement need parentheses.

### Optional key read

`the optional k of x` reads only a map key. Its key can be a Word, a Text
literal, the two-word key `code points`, or a parenthesized expression.
Bare `length`, `target`, `first` and all other key spellings are literal keys,
not Built-in properties, the message target or ordinal chunks.

For a computed key, evaluate the key expression, then the receiver expression,
once each in source order. After both finish, require the key to be text.
A non-text key raises `wrong kind`, `expected: "text"`, `value` the key,
even when the receiver is Nothing. Operand errors happen before this final
validation: an error in the receiver expression is not hidden by an invalid
key value computed earlier.

Then dispatch on the receiver:

- Nothing returns Nothing.
- A map returns its value under that key, or Nothing if absent. A present key
  holding Nothing and an absent key yield the same result.
- Every other value raises `wrong kind`, `expected: "map"`, `value` the
  receiver. Host Objects, live or disposed, are rejected even for `id`.

Optional reads never call the Host, perform property dispatch or coerce a
receiver into a map. A map value may itself be a Host Object; returning the
handle is allowed, but the next optional read cannot step into it.

An error from the read instruction has `at` at its `the` token. Operand errors
retain their own source positions. Both statements remain subject to the
existing Standard Library attribution rule: an operator error raised inside
stdlib source points to the entering Script call, as specified in
[chapter 6](../../spec/06-errors-and-limits.md#errors). No cumulative `path` field is added:
these are individual expressions rather than one Value Path operation.
No new Error Code is needed.

Every nullable step must be explicit. In `the optional b of the a of m`, the
inner ordinary read may still fail. In
`the optional b of the optional a of m`, either Nothing receiver is tolerated,
but a numeric receiver still fails. Computed key expressions in outer steps
still run: this is not whole-chain short-circuiting.

There is no optional possessive, chunk, call or assignment form. Optional
reads are not Containers; `put`, `set`, `add`, `delete` and other writes must
reject them under the existing `not a container` syntax rule, at the
Container's first token. They do not create maps or keys.

Ordinary reads retain all existing behavior, including Built-in properties,
Host access and errors when reading a key from Nothing.

### Guards and other restricted expressions

Both forms are allowed in Guards. Check every operand, including branches
that will not run, against existing Guard restrictions. Thus
`true otherwise scriptFunction()` is still `not in a guard` inside a Guard.
A nonboolean final result or a runtime error skips the clause under the
existing Guard rules and is recorded as such in the Trace.

Optional reads of a statically known Host Object use the same map-only
runtime rejection as reads of a dynamic object. They are not ordinary Host
property accesses, so the existing special load rule for such accesses does
not apply to them. Ordinary `the id of object` remains allowed in Guards;
`the optional id of object` fails at runtime and skips the clause.

Whose conditions, Constants, Script Variable initializers and parameter
defaults retain their existing expression restrictions. Both forms are
eligible wherever their operands are eligible; a lazy branch does not hide
a forbidden call or unresolved name. Loader evaluation uses the same value
rules, with initializer errors handled as existing load errors.

## Grammar and lexical changes

These changes are in `spec/data/grammar.ebnf`:

```ebnf
Expression     ::= Lambda | EveryHead Whose | Default Whose?
Default        ::= Or ( 'otherwise' Or )*
OptionalKey    ::= Key | Text | '(' Expression ')'
The            ::= 'the' ( 'optional' OptionalKey 'of' Postfix
                         | '(' Expression ')' 'of' Postfix | Text 'of' Postfix | 'target'
                         | Ordinal ( 'code' 'point' | Name ) 'of' Postfix | Key 'of' Postfix )
```

Keep the restriction that trailing `Whose?` applies only when the preceding
expression is an ordinal Chunk Expression. The apparent overlap between
`Key` and `optional` is resolved by one registered decision: after `the`,
`optional` followed by `of` is the existing ordinary key read; otherwise
`optional` begins the new branch. `the optional of m` therefore keeps its
old meaning. Use `the optional optional of m` for an optional read of that
key, and quote the key `of`: `the optional "of" of m`.

`grammar.toml` adds `otherwise` as a contextual operator, lowest ordinary
binary precedence, left-associative, in FOLLOW and among the excluded
Argument Labels. `optional` is contextual only after `the`, with the
registered `optional-key` two-token decision. Neither word is a Reserved
Word, and neither feature is an Advanced Construct; both belong to the
ordinary expression surface.

A trailing `otherwise` in operator position continues the line, including
across a trailing comment. An operand named `otherwise` does not. Starting
the next line with `otherwise` does not continue the previous line and may
instead start a Command Call. `optional` itself adds no continuation rule.
Both changes use existing tokens and require no lexer backtracking.

## Abstract Machine, lowering and Fuel

`machine.toml` declares three instructions. All are synchronous,
allocate no result storage of their own, and obey existing instruction Fuel
charging and Limit Fault behavior.

`branch-not-nothing label`: control group, pops 1, pushes 1, jumps 1, cost
`branch`. Pop the top value and push that same value back, without copying
or converting it. If it is not Nothing, jump to `label`; otherwise continue
to the next instruction. This stack signature lets the existing verifier
reject an empty incoming stack while preserving the value on both edges.
It performs no boolean conversion and raises no Script error.

`get-optional-key key`: access group, pops 1, pushes 1, cost `get-key`.
Pop the receiver and apply the literal optional-read rules above.
Errors: `wrong kind` only.

`get-optional-key-computed`: access group, pops 2, pushes 1, cost `get-key`.
Pop the receiver and the key below it. Validate the key before receiver-kind
dispatch, using the computed optional-read rules above.
Errors: `wrong kind` only.

The lowering, normative in chapter 8:

```text
⟦a otherwise b⟧ = ⟦a⟧ branch-not-nothing done; pop; ⟦b⟧; done:
⟦the optional k of x⟧ = ⟦x⟧ get-optional-key k
⟦the optional (k) of x⟧ = ⟦k⟧ ⟦x⟧ get-optional-key-computed
```

The branch and pop are positioned at `otherwise`; either optional-read
instruction is positioned at `the`. Operand instructions keep their own
positions. The same instructions run inside Guards; optional reads need no
Host-permitting variant. No hidden local or repeated operand evaluation is
introduced. Error unwinding uses the existing stack cleanup rules.

Reuse current rates: `branch = 1`, `stack = 1`, `get-key = 3`. Update the
`get-key` rate's input description to include optional Nothing receivers;
optional reads never charge Host conversion. An optional read costs 3 Fuel
beyond its operands, including a missing key, Nothing receiver or wrong-kind
failure. A default operator adds 1 Fuel when the left side is present, or
2 plus the right side's Fuel when it is Nothing. Unselected operands consume
no Fuel or allocation budget.

These totals exclude surrounding statement/return and body instructions:

```text
1 otherwise 2                         -- 2: const + branch
nothing otherwise 2                   -- 4: const + branch + pop + const
1 otherwise 2 otherwise 3             -- 3: const + two branches
nothing otherwise nothing otherwise 3 -- 7: three consts + two branches + two pops
```

Lower a chain as its left-associated syntax tree. Do not optimize the first
present value into a jump past all later default operators: that would
remove the required branch charges. No new Trace record or value kind is
introduced; Disassembly, Fuel totals and source positions are observable.

## Compatibility and release

This is intentionally source-breaking despite both words being contextual:

- Rename an Argument Label `otherwise` in declarations, calls, `pass`,
  target-first sends and event heads. Update dynamic Selector strings and
  Host message producers/consumers to match. A declaration diagnostic alone
  cannot make migration safe: old sends can silently target another message.
- Group an index variable named `otherwise`: replace
  `item otherwise of xs` with `item (otherwise) of xs`.
- Variables, functions, Handlers and map keys named `otherwise` remain legal.
  The ordinary key `optional` retains its syntax and behavior.

The integration is released as language **1.0-rc.3**, retaining provisional
**Cost Model 0** under the existing
[prerelease exception](../../spec/08-the-abstract-machine-and-the-cost-model.md#prerelease-cost-model-exception)
([#722](https://github.com/odogono/odgn-talk/issues/722)). `costs.toml`'s
change history records the lowering change; version declarations, Trace
headers and Group Fingerprints were regenerated, and affected expectations
re-blessed under the corpus approval workflow. Cost Model 1 remains reserved
for calibration. There is no dual grammar or automatic source migration.
Existing save mismatch handling applies: a 1.0-rc.2 save is a mismatch, so
`RejectMismatch` refuses it with `save mismatch` and `VariablesOnly` keeps
only its Script Variables ([chapter 10](../../spec/10-save-and-restore.md#restoring)).
No automatic snapshot migration or preservation of renamed message
Selectors is promised.

The library `lookup` remains supported and unchanged. Both forms agree on
missing/Nothing map steps and rejection of non-map receivers, including
Host Objects. They differ intentionally in evaluation: `lookup` evaluates
its default argument eagerly and validates an entire path before traversal;
`otherwise` is lazy and optional expressions evaluate their own key and
receiver. `lookup` also handles list positions and reports cumulative paths.

## Acceptance cases

The ten groups below are required observations. The corpus covers them on
TS, Go and Zig, in ordinary and Save/Restore replay; first blessing is a
separate human review ([corpus guide](../../corpus/README.md#seed-blessing)).

| Group | Corpus cases |
| --- | --- |
| 1 | [`nothing-defaults/values`](../../corpus/nothing-defaults/values/) |
| 2 | [`nothing-defaults/evaluation-order`](../../corpus/nothing-defaults/evaluation-order/), [`nothing-defaults/fuel-boundaries`](../../corpus/nothing-defaults/fuel-boundaries/) |
| 3 | [`nothing-defaults/values`](../../corpus/nothing-defaults/values/), [`load-diagnostics/nothing-defaults`](../../corpus/load-diagnostics/nothing-defaults/), [`disassembly/nothing-defaults`](../../corpus/disassembly/nothing-defaults/) |
| 4 | [`nothing-defaults/values`](../../corpus/nothing-defaults/values/) |
| 5 | [`nothing-defaults/evaluation-order`](../../corpus/nothing-defaults/evaluation-order/), [`nothing-defaults/stdlib-attribution`](../../corpus/nothing-defaults/stdlib-attribution/) |
| 6 | [`nothing-defaults/host-objects`](../../corpus/nothing-defaults/host-objects/), [`nothing-defaults/guards`](../../corpus/nothing-defaults/guards/) |
| 7 | [`nothing-defaults/guards`](../../corpus/nothing-defaults/guards/), [`load-diagnostics/nothing-defaults`](../../corpus/load-diagnostics/nothing-defaults/) |
| 8 | [`nothing-defaults/values`](../../corpus/nothing-defaults/values/), [`load-diagnostics/nothing-defaults`](../../corpus/load-diagnostics/nothing-defaults/), [`load-diagnostics/constant-unknown-name`](../../corpus/load-diagnostics/constant-unknown-name/) |
| 9 | [`nothing-defaults/compatibility`](../../corpus/nothing-defaults/compatibility/), [`load-diagnostics/nothing-defaults`](../../corpus/load-diagnostics/nothing-defaults/) |
| 10 | [`nothing-defaults/fuel-boundaries`](../../corpus/nothing-defaults/fuel-boundaries/), [`disassembly/nothing-defaults`](../../corpus/disassembly/nothing-defaults/); the empty-stack verifier check is a TS unit test ([lowering tests](../../impl/ts/tests/lowering.test.ts)) |

Go refuses a local named like a Handler
([#764](https://github.com/odogono/odgn-talk/issues/764)), so `compatibility`
doesn't pair a Handler and a local named `otherwise`. An unresolved fallback in
a Constant is `unknown name` and `not constant` at the same token;
`load-diagnostics/constant-unknown-name` checks it
([#765](https://github.com/odogono/odgn-talk/issues/765)).

1. Default only Nothing: explicit Nothing and absent map keys use the
   fallback; false, zero, empty text, list and map do not. A fallback may
   itself return Nothing or any other value.
2. Count calls and log order: the left side runs once; the fallback runs once
   only if selected. Errors in the left side propagate; errors in an
   unselected right side do not execute. A left-associated three-candidate
   chain preserves source order and the exact Fuel totals above.
3. Parse precedence against arithmetic, comparisons, `and`, `or`, Lambdas,
   Whose Clauses, parentheses, lists/calls and restricted replace slots.
   Exercise trailing continuation, comments, names at line ends and missing
   operands. Record source positions in diagnostics and Disassembly.
4. Optional literal, quoted and computed reads: present, absent and explicit
   Nothing values; Nothing at every level; mixed ordinary/optional chains;
   `length`, `target`, `first`, reserved keys, `code points`, `optional` and
   quoted `of`. Existing `the optional of m` must retain its parse.
5. Computed keys: key expression runs before receiver, both once. An invalid
   key followed by an erroring receiver reports the receiver error; invalid
   key plus Nothing reports `wrong kind`, expected text. A valid key plus
   number/list/text/Bytes reports expected map. Check `value`, `at`, absence
   of a fabricated path, and instruction charge on failures. An optional-read
   or evaluated-operand error raised inside stdlib source must retain the
   existing attribution to the entering Script call.
6. Live and disposed Host Objects, known and dynamic, fail optional reads
   for both `id` and another key, with zero Host calls. Returning a Host
   Object stored under a map key succeeds; stepping into it fails.
7. Guards: absent optional boolean key with `otherwise false` skips normally;
   present true chooses the clause. Runtime wrong-kind errors skip with the
   existing Trace behavior. Forbidden Script/Library calls in either branch
   fail checking, including an unselected branch. Ordinary Guard `id` reads
   remain supported.
8. Constants, initializer and parameter-default eligibility; Whose checking;
   all assignment forms reject optional Containers. Verify normal reads and
   normal Built-in properties have unchanged behavior.
9. Compatibility: old label declarations/events reject; old command/send
   witnesses show the documented Selector change; grouped indexes survive.
   Migrated labels and Host message names work together.
10. Machine verification rejects `branch-not-nothing` with an empty stack
    and accepts equal stack depth on its branch and fallthrough edges.
    Disassembly emits all three instructions, source maps point correctly,
    budget exhaustion immediately before branch/pop/read faults consistently,
    and TS/Go/Zig agree on values, errors, Fuel and Trace observations.

No stdlib source contains these expressions, so the corpus checks the
stdlib attribution rule through stdlib calls as operands and Lambdas the
stdlib calls. A TS unit test ([Library tests](../../impl/ts/tests/libraries.test.ts))
checks reads compiled as stdlib-attributed code.

## Implementation record

- **Implemented in:** design [#718](https://github.com/odogono/odgn-talk/pull/718);
  TS Core and shared tooling [#755](https://github.com/odogono/odgn-talk/pull/755),
  including Go [#757](https://github.com/odogono/odgn-talk/pull/757) and
  Zig [#760](https://github.com/odogono/odgn-talk/pull/760); language
  1.0-rc.3 activation and cross-Core Trace cases for
  [#722](https://github.com/odogono/odgn-talk/issues/722).
- **Approval still needed:** first blessing of every expectation the
  acceptance table names. Each carries an `Unblessed` header, which the
  reviewer removes on approval.
