# locale

<!-- Generated from spec/data/stdlib.toml by tools/spec/generate.ts. Edit those, then run `bun run spec:gen`. -->

`locale` is a Standard Capability: a Script calls its Operations through a Grant the Host gives it, with `ask` for an answer or `tell` for none, and a suspending one with `and wait`. A call the Grants don't allow fails to load. The full rules: [chapter 7](../../../spec/07-libraries-and-the-standard-library.md#locale). Arguments are checked against the Operation's Shapes, and a mismatch raises `wrong kind`; the entries below list the other errors.

### compare

`compare a, b [, options] [, tag]`, immediate

-1, 0 or 1, as the text `a` sorts before, with or after `b` under the Locale's Collation.

Errors: [`bad locale`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### rank

`rank texts [, options] [, tag]`, immediate

A map from each distinct text of the list `texts` to its dense, 1-based rank under the Locale's Collation.

Errors: [`bad locale`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### upper

`upper s [, tag]`, immediate

`s` under the Locale's uppercase mapping, then NFC.

Errors: [`bad locale`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### lower

`lower s [, tag]`, immediate

`s` under the Locale's lowercase mapping, then NFC.

Errors: [`bad locale`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### numberSymbols

`numberSymbols [tag]`, immediate

The map `{decimal, group, minus, digits, primaryGroup, secondaryGroup, minGrouping}` for the Locale.

Errors: [`bad locale`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### monthNames

`monthNames [options] [, tag]`, immediate

The Locale's 12 month names, January first.

Errors: [`bad locale`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### dayNames

`dayNames [options] [, tag]`, immediate

The Locale's 7 day names, Monday first.

Errors: [`bad locale`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### tag

`tag [tag]`, immediate

The BCP 47 tag of the Locale in use, after fallback.

Errors: [`bad locale`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).
