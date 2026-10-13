# Nothing defaults and explicit optional key reads

Design exploration for [#687](https://github.com/odogono/odgn-talk/issues/687),
checked against repository revision `0ea3a15c` on 2026-10-13. This is a
nonnormative proposal, not accepted syntax or an implementation handoff. The
issue's latest reopen check found neither trigger; exploring a design does not
supply that missing usage evidence. Hypothetical examples use `text` fences,
as in the [pipeline exploration](pipeline-operator.md).

## Selected direction

The user selected **`otherwise` and explicit optional map-key reads** after
reviewing the compatibility findings and xTalk precedent. The current
[specification draft](../design/nothing-defaults.md) defines their behavior,
grammar, lowering, Fuel and acceptance cases. It supersedes this exploration's
earlier preference for `??` and its recommendation to defer optional reads.
The prototype's compatibility findings remain valid; the tradeoff is accepted.

`x otherwise d` evaluates `x` once, returns it unless it is Nothing, and only
then evaluates `d`. False, zero, empty text and empty collections remain
values. Errors propagate. `or` retains its boolean-only meaning.

The selected optional-read form is:

```text
put the second of found otherwise 0 into s
put the optional city of the optional address of customer otherwise "unknown" into city
```

The first removes a repeated single-level default assignment, like
`second` in [date.talk](../../spec/stdlib/date.talk). The second marks each
read allowed to receive Nothing. Ordinary `the k of x` and `x's k` retain
all their current behavior, including errors on Nothing and Host properties
([keys and properties](../../spec/04-expressions-and-statements.md#keys-and-properties)).

## Concrete grammar sketch

The [current productions](../../spec/data/grammar.ebnf) put `or` at the
lowest ordinary binary level, with Lambdas and Whose Clauses as whole
expressions. Add a lower level, leaving their existing boundaries intact:

```text
Expression ::= Lambda | EveryHead Whose | Default Whose?
Default    ::= Or ( 'otherwise' Or )*
```

The existing restriction on `Whose?` stays: its preceding expression must
itself be an ordinal Chunk Expression. `otherwise` is left-associative and
binds less tightly than every existing binary operator. A chain tests its
candidates once in source order and returns the first non-Nothing value,
or Nothing when every candidate is Nothing.

```text
a otherwise b otherwise c   -- (a otherwise b) otherwise c
a + b otherwise 0           -- (a + b) otherwise 0; arithmetic errors propagate
a otherwise b or c          -- a otherwise (b or c)
(a otherwise false) or b     -- default a before testing a boolean disjunction
(a otherwise 0) > 3         -- parentheses default a before comparing it
```

Preserve the [whole-expression boundaries](../../spec/04-expressions-and-statements.md#whose-clauses):
`the first item of xs whose active otherwise false` defaults the condition,
not the selection. Default the selection with
`(the first item of xs whose active) otherwise fallback`. Likewise,
`given x: x otherwise d` defaults the Lambda's result; a Lambda used as a
fallback operand needs parentheses, as it does in other binary expressions.
Do not silently broaden other restricted productions: for example,
`ReplaceExpression` currently takes `Or` for its subject and `Concat` for its
replacement, so either slot needs parentheses around a default expression.

For the optional read, add one branch to `The`:

```text
OptionalKey ::= Key | Text | '(' Expression ')'
The         ::= 'the' ( 'optional' OptionalKey 'of' Postfix | ...existing branches... )
```

After `the`, `optional` followed by `of` retains the existing ordinary key
read. Otherwise `optional` starts this new branch and requires an
`OptionalKey`. `Key` reuses the current `Word | 'code' 'points'` production.
Thus `the optional of m` still reads the key `optional`, while
`the optional optional of m` optionally reads that same key. Once the branch
is selected, its key is always literal, quoted or computed map-key access:
`the optional length of m` means the key `length`, never the Built-in
property. `the optional code points of m` similarly names `code points`.
There is no optional chunk, possessive, call or Container form.

These decisions fit the local two-token choices required by
[ADR 0019](../adr/0019-one-predictive-grammar-with-contextual-keywords.md),
and the default-operator prototype below exercised its interaction with
the existing parser. The optional-key follow-up also exercises its grammar; neither
result is an exhaustive proof of the grammar.

## Contextual compatibility

`otherwise` remains a Name in operand and declaration positions: a variable,
function or Handler named `otherwise` remains possible. In operator position
it starts the default expression. Add it to `follow` and `[[contextual]]` in
[grammar.toml](../../spec/data/grammar.toml), and to its operator levels.
Otherwise `line otherwise 0` could start a chunk index rather than default
the variable `line`. That change also means an index variable named
`otherwise` needs grouping: `line (otherwise) of report`.

An Argument Label cannot start an operator that continues the previous
expression ([Label production](../../spec/data/grammar.ebnf)); therefore an
existing label named `otherwise` is a source-compatibility concern even
though the word is not reserved. Prototype and migration review must cover
Handler labels, command phrases and `send to …:` together, rather than
claiming that a contextual word cannot break any Script.

The current [grammar parser](../../tools/grammar/parser.ts) accepts these
forms (checked at the revision above): `return item otherwise of xs` with
an index parameter named `otherwise`; a Handler head `on demo x otherwise d`;
and the command phrase `foo 1 otherwise 2`. The last currently names
`foo:otherwise:` with two arguments, but the proposed operator would silently
turn it into one argument to `foo`. Acceptance therefore requires an explicit
compatibility decision: exclude `otherwise` from Argument Labels, supply
migration advice/diagnostics and decide how older language versions behave.
If preserving all existing parses is required, this spelling must be rejected
or gated by a new language version. The prototype below also verifies these changes in the candidate parser.

Extend [line continuation](../../spec/01-lexical-structure.md#lines) only for
`otherwise` in operator position. A trailing default operator continues a
line; one at the start of the next line does not continue the previous one.
A Name operand `otherwise` at line end must not accidentally continue it.
`optional` is contextual only after `the`; no global FOLLOW entry is needed.

## Optional read semantics and boundaries

An optional read evaluates its computed key, if any, then its receiver, once
each in source order. Require a text key before performing the lookup, even
when the receiver is Nothing. Nothing gives Nothing; a map gives the value
under the key, or Nothing when absent. Every other receiver raises `wrong
kind`, with `expected: "map"`. In particular **every Host Object is rejected,
including a read of `id`**; this operation never calls the Host.
The default operator itself can return a Host Object as a non-Nothing value;
it performs no property access.

This follows the map-key domain of
[`lookup`](../../spec/07-libraries-and-the-standard-library.md#map), whose
[normative source](../../spec/stdlib/map.talk) validates its Value Path and
rejects non-map text steps. It does not imply identical evaluation behavior:
`lookup(m, path, fallback())` evaluates its fallback argument eagerly,
whereas `… otherwise fallback()` is lazy. Optional key reads also do not
replace lookup's integer list steps or its path-bearing errors.

Each optional step only handles its own Nothing receiver. In
`the optional b of the a of m`, the inner ordinary read can still fail.
`the optional b of the optional a of m` tolerates Nothing at both steps,
but a number at either step still fails. A Host Object may be returned as a
map value; it cannot be stepped into by the next optional read.

Both constructs can be admitted in Guards under the existing
[purity rules](../../spec/04-expressions-and-statements.md#guards): check all
subexpressions, including lazy fallback branches, for forbidden calls.
Optional keys never use the ordinary Guard's special permission to read an
Object's `id`. A runtime wrong-kind error skips the clause under existing
Guard behavior; `otherwise` does not turn that error into a default.

For this proposal, computed-key validation runs after both operand expressions
finish, but before inspecting the receiver's kind. A non-text key raises
`wrong kind` with `expected: "text"` and `value` the key, even on Nothing.
A receiver error uses `expected: "map"` and `value` the receiver. Attribute
either error to the optional read's `the`; an error evaluating an operand
keeps that operand's position. Do not manufacture a cumulative `path`:
these are individual key expressions, unlike a Value Path passed to `lookup`.
This uses the existing [error catalogue](../../spec/06-errors-and-limits.md#the-error-code-catalogue).
A statically known Host Object is also rejected at runtime by this map-only
operation, including in Guards; the existing load restriction on ordinary
Host property reads remains unchanged.

## Proposed acceptance examples

These are expected outcomes of the proposal, not executable fixtures yet:

```text
nothing otherwise 7                         -- 7
false otherwise true                        -- false
0 otherwise 7                               -- 0
"" otherwise "missing"                       -- ""
[] otherwise [1]                            -- []
{} otherwise {a: 1}                         -- {}
1 otherwise (1 / 0)                         -- 1; right side never evaluated
(1 / 0) otherwise 7                         -- division by zero
the optional a of {}                        -- Nothing
the optional a of {a: nothing}              -- Nothing
the optional a of nothing                   -- Nothing
the optional a of 12                        -- wrong kind, expected map
the optional length of {length: 9}          -- 9, not the map's size
the optional (12) of nothing                -- wrong kind, expected text
the optional b of the optional a of {} otherwise 7  -- 7
the b of the a of {} otherwise 7            -- wrong kind; no error recovery
```

Additional cases must count calls to prove single evaluation and source
order, and exercise live and disposed Host Objects (including `id`),
Guard clause skips, forbidden calls in an unselected fallback, initializer
restrictions, and rejection of optional reads as assignment Containers.
An ordinary Host property read on the left of `otherwise` still follows
ordinary Host access rules; the operator itself provides no purity guarantee.

## Alternatives and recommendation

Changing every ordinary key read to tolerate Nothing is shorter, but changes
existing errors and still needs a separate rule for Host Objects. Prefer an
explicit map-only operation if nested-read syntax is eventually justified.
Reusing `or` would change its boolean contract. A regular `default(x, d)`
function cannot provide lazy fallback under current argument evaluation;
requiring a Lambda would exclude it from Guards. Symbol spellings such as
`??` avoid the `otherwise` label collision, but trade away the English
spelling and require new tokens. They are the fallback design to investigate
if source compatibility outweighs the word-based syntax.

The compatibility-only preference for `??` was not adopted: the user prefers
English xTalk-style syntax and accepted the migration cost of `otherwise`.
Optional reads are included too. The observations below retain the evidence
behind that decision, rather than treating a clean repository scan as proof
that no external source can break.

## Parser experiment: 2026-10-13

The throwaway prototype is captured in branch
`prototype/issue-687-default`, commit `c98d2a1a`, based on `0ea3a15c`.
Its entry point is `tools/grammar/prototype-default.ts`, beside the reference
parser it varies. That branch also contains `prototype-default-README.md`
and the full AST/error observations in `prototype-default-results.txt`.
The [prototype branch](https://github.com/odogono/odgn-talk/tree/prototype/issue-687-default/tools/grammar) retains its runnable source and captured output. Reproduce it in that
branch's checkout with `bun tools/grammar/prototype-default.ts`.

The runner generates isolated parser variants and removes them after the
run. It leaves the reference parser and normative Data Files unchanged.
Both variants add the default-expression level below `or`; the word variant
adds FOLLOW, label-exclusion and continuation entries, while the symbol
variant adds a `??` lexer token and leaves the word lists alone.

**Observed:** 41 focused cases exercised precedence, association, grouping,
Whose/Lambda boundaries, line breaks and comments, names, labels, target-first
sends, events, restricted replace slots, patterns and missing operands.
Both candidates ran with zero relexes, no third-token lookahead requests and
no new second-token decision sites. The existing guards against extra
lookahead and undeclared decisions were retained.

The baseline accepted 609 of 624 tracked `.talk` files. Both variants
preserved every accepted file's complete AST, including positions. The 15
baseline-rejected files were excluded, so this does not establish diagnostic
parity for rejected source. Focused cases print observations; they are not
a new conformance suite.

The deliberate compatibility witnesses confirmed that `otherwise` changes
both `foo 1 otherwise 2` and `send to receiver: foo 1 otherwise 2` from the
selector `foo:otherwise:` to `foo`. Excluding the word from labels rejects
old declarations and event heads, but cannot prevent a call or send from
silently targeting another selector. The symbol candidate preserves those
old parses and the unparenthesized chunk index `item otherwise of xs`.

Both candidates implement the proposed grouping. A trailing operator
continues the line, including across a comment. A leading `otherwise d`
on the next line remains a separate command; a leading `?? d` is an error.
Neither continues the preceding line. `otherwise` remains usable as a
variable, function, Handler or key.

**Verdict:** the predictive grammar is not the obstacle in the exercised
cases; compatibility is. Prefer `??` unless a language-version break and
migration are explicitly accepted for the English spelling. This result
establishes neither runtime semantics nor reader preference. Checking,
lowering, Fuel, lazy execution and optional reads were not implemented.

## Optional-key follow-up and selected specification

The follow-up is captured on the same prototype branch at `ce05553e`.
It adds 16 optional-key cases, for **57 focused cases** in total. Literal,
quoted, computed, reserved, property-looking and ordinal-looking keys,
multiword keys, nesting and Guard syntax parse as proposed. Optional reads
are rejected as Container targets, including `set`; optional chunks remain
invalid. The new `optional-key` two-token decision preserves the old
`the optional of m` read. There are zero relexes and the same 609 unchanged
baseline-accepted repository files. No runtime behavior was implemented.

The [specification draft](../design/nothing-defaults.md) is the current design
handoff for both features. It keeps live generated grammar/instruction
catalogues unchanged until implementation can satisfy their consumer checks.

## Evidence and remaining validation

The original real-Script evidence gate remains unmet; the selected design
was authorized separately. Future usage validation should seek Scripts showing
that the shorter form helps, especially whether the word `optional` teaches
map-only semantics clearly enough. The default-operator parser questions now have the bounded evidence above;
the optional-key follow-up supplies the same bounded grammar evidence. Pin evaluation
order, single evaluation, lazy fallbacks, explicit Nothing, malformed
computed keys, Host rejection and Guard behavior in corpus cases. Adopt and verify the draft's lowering, Fuel and error-field definitions when
splitting implementation across TS, Go and Zig. No runtime parity or
expectation approval has yet been established.
