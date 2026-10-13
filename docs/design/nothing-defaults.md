# Specification draft: Nothing defaults and optional map-key reads

For [#687](https://github.com/odogono/odgn-talk/issues/687), based on
`0ea3a15c`, 2026-10-13. The selected design is **`otherwise` plus optional
map-key reads**. The word spelling is selected for xTalk style, with its source-compatibility
cost accepted. `??` is not part of this design.

This is a complete behavior and lowering draft for review, not an active
language declaration. It deliberately stages the grammar and instruction
catalogue edits with implementation, as permitted by the
[Spec change-impact guide](../agents/spec-changes.md#splitting-delivery).
Current Cores do not support this syntax. The existing Spec and generated
Data Files continue describing the implemented language until integration.
The [exploration](../research/nothing-default-syntax.md) records alternatives.

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
retain their own source positions. No cumulative `path` field is added:
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

Apply these changes to `spec/data/grammar.ebnf` at integration:

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

In `grammar.toml`, add `otherwise` as a contextual operator, lowest ordinary
binary precedence, left-associative; add it to FOLLOW and excluded Argument
Labels. Add `optional` as contextual only after `the`, and register the
`optional-key` two-token decision. Add neither word to Reserved Words.
Neither feature is designated an Advanced Construct by this draft; both
belong to the ordinary expression surface.

A trailing `otherwise` in operator position continues the line, including
across a trailing comment. An operand named `otherwise` does not. Starting
the next line with `otherwise` does not continue the previous line and may
instead start a Command Call. `optional` itself adds no continuation rule.
Both changes use existing tokens and require no lexer backtracking.

## Abstract Machine, lowering and Fuel

Add three instructions to `machine.toml` at integration. All are synchronous,
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

Normative lowering proposed for chapter 8:

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

Release the integration as language **1.0-rc.3**, retaining provisional
**Cost Model 0** under the existing
[prerelease exception](../../spec/08-the-abstract-machine-and-the-cost-model.md#prerelease-cost-model-exception).
Record the lowering change in `costs.toml`'s change history and regenerate
version declarations, Trace headers and Group Fingerprints. Re-bless affected
expectations under the corpus approval workflow. Cost Model 1 remains reserved
for calibration. This design-only PR does not activate either version change.
No dual grammar or automatic source migration is proposed.
Existing save mismatch handling applies; no automatic snapshot migration
or preservation of renamed message Selectors is promised.

The library `lookup` remains supported and unchanged. Both forms agree on
missing/Nothing map steps and rejection of non-map receivers, including
Host Objects. They differ intentionally in evaluation: `lookup` evaluates
its default argument eagerly and validates an entire path before traversal;
`otherwise` is lazy and optional expressions evaluate their own key and
receiver. `lookup` also handles list positions and reports cumulative paths.

## Acceptance cases to move into the corpus

These are required observations, not blessed expectation files yet.

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
   of a fabricated path, and instruction charge on failures.
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

## Implementation handoff

- **Required base:** the design PR containing this file and
  `docs/research/nothing-default-syntax.md`, based on `0ea3a15c`.
  Implementation issues pin the PR and exact specification commit; while
  that PR is unmerged, they depend on it. Confirm both files are present
  before starting implementation.
- **Implemented in:** parser experiments only, on local branch
  `prototype/issue-687-default`. No Core runtime or checker implements this.
- **Remaining work:** integrate the grammar/keyword changes, three instruction
  declarations and lowering, source maps, error/cost descriptions and the release
  revision above. Update chapters 1, 2, 4, 6 (key error description), 7 (`lookup`
  cross-reference) and 8; generate their Data File regions. Update the
  reference parser/compiler, TS/Go/Zig parsers, checkers, constant evaluators,
  runtimes and cost paths. Update formatter/parentheses, highlighting,
  completion, LSP and debugger consumers, plus Core guides and migration
  documentation. Add a breaking `feat(spec)` changelog fragment on adoption.
- **Acceptance still needed:** all ten groups above, with generated
  Disassembly and Trace expectations kept separate from first blessing.
  No new expectation file is awaiting approval yet.
- **Validation at integration:** follow each Core's task map and the Spec
  change-impact guide; regenerate Spec/syntax/Go/Zig tables, run grammar and
  machine checks, focused parser/checker/runtime/tooling tests and cross-Core
  corpus cases, then required repository checks. A clean prototype scan is
  not evidence of runtime parity or expectation approval.
