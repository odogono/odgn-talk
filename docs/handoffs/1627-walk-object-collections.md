# Walking an Object Collection: specification handoff for #1627

## Required base and delivery boundary

- **Specification revision:** this PR, based on the merge of
  [ADR 0138](../adr/0138-an-object-collection-is-walked-as-an-eager-snapshot-list.md).
- **Staged delivery** ([spec-changes.md](../agents/spec-changes.md#splitting-delivery)):
  this PR specifies the prose in chapter 4 and the
  [object element contract](../../spec/embedding/object-elements.md#walking-a-collection).
  It deliberately leaves the executable catalogues unchanged, because adding
  `list-elements` or the new grammar alone fails Core coverage.
- **Deferred to the implementation PR:**
  - `grammar.ebnf`/`grammar.toml`: `element` as an Every Head and ordinal
    Whose head, and `elements` as a Built-in property;
  - `machine.toml`/`costs.toml`: `list-elements` and its rate;
  - the `function: "elements"` and `"list-elements"` diagnostics fields;
  - the reference parser and lowering, the TS and Zig Cores, and shared
    Corpus cases.
- **After the implementation:** tag `reactor-v*` and re-pin the Elixir Host.

## Acceptance

Corpus cases on both Cores cover: `repeat for each` over `the elements of o`;
`every element … whose` and `the first element … whose` reading every member
before testing; an empty collection calling only `Count`; a disposed member
raising `object gone` at use; `At` giving Nothing below the count as
`host error`; a Limit Fault part way through the read; a list receiver
raising `wrong kind`; `not in a guard`; `restricted operation`; and the
`prop` records, one per callback. New expectations need first blessing
through the [corpus workflow](../../corpus/README.md#checking).
