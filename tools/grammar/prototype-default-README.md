# Default operator parser prototype (#687)

THROWAWAY, based on `0ea3a15c`, run on 2026-10-13. This experiment answers
whether a lazy-default expression can fit the two-token predictive grammar,
and whether `otherwise` or `??` preserves existing source meanings. It does
not implement runtime evaluation, checking, lowering, Fuel or optional reads.

Run from the repository root:

```sh
bun tools/grammar/prototype-default.ts
```

The runner generates isolated variants beside the reference parser, imports
them, prints complete compact ASTs/errors, then deletes the generated files.
It leaves the reference parser, lexer and Spec unchanged. Don't run two copies
concurrently, because their temporary filenames are shared.

## What changed in the variants

Both add `Default ::= Or ( operator Or )*` and call it from the ordinary
Expression branch, retaining Lambda/Whose and restricted operand boundaries.
The word variant adds `otherwise` to FOLLOW, excluded argument labels and
operator-position line continuation. The symbol variant adds the `??` token
to a copied lexer; it changes no word lists. Neither changes the two-token
lookahead guard, decision catalogue checks, or relex instrumentation.

## Results

The captured output is [prototype-default-results.txt](prototype-default-results.txt).
41 focused examples cover precedence, association, grouping, Whose/Lambda
boundaries, line breaks, comments, names, labels, sends, events, restricted
replace slots, patterns, binary builds and missing operands. These print
observations rather than assert an expected tree. The output was inspected;
there is no claim of exhaustive grammar proof or runtime acceptance.

Of 624 tracked `.talk` files, the baseline parser accepted 609 and rejected
15. For every accepted file, both variants produced exactly the same AST,
including positions. Baseline-rejected files were excluded from comparison;
this is not a check of their diagnostics. There were zero relexes across the
focused parses and candidate scans, no third-token requests, and no new
second-token decision sites.

The deliberate compatibility witnesses matter despite that clean scan:

- `foo 1 otherwise 2` changes from selector `foo:otherwise:` with two
  arguments to selector `foo` with one default-expression argument.
- `send to receiver: foo 1 otherwise 2` has the same silent selector change.
- `on demo x otherwise d` and `wait for foo x otherwise d` stop parsing when
  `otherwise` is excluded from labels.
- `item otherwise of xs` stops parsing; `item (otherwise) of xs` survives.
- `otherwise` remains usable as a variable, function, Handler or key.
- A line beginning `otherwise d` remains a separate command. A line beginning
  `?? d` fails. Neither spelling continues a preceding line from that position.
- Both spellings preserve the proposed below-`or` precedence and left
  association. Parentheses remain necessary to default a selection rather
  than its Whose condition, or to default before a comparison.

## Verdict

Both spellings are viable in the exercised predictive parser. Prefer `??`
if preserving source compatibility is the requirement: it avoids the demonstrated
identifier/selector collisions with the same expression behavior. Choosing
`otherwise` requires accepting a source-breaking migration or version gate;
excluding label declarations alone cannot prevent silent retargeting of sends.
This experiment does not settle readability for the HyperTalk audience or
supply the issue's missing real-world usage evidence. Optional reads stay deferred.

The prototype is retained on local branch `prototype/issue-687-default`;
the proposal in the working branch captures this finding. No Core changes
should be inferred from this branch.
