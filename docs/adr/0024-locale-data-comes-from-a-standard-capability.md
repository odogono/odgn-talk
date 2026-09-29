# Locale data comes from a Standard Capability, and formatting stays in the language

`locale` is the third Standard Capability. The spec fixes its Operation Declarations and each Host supplies the answers. It offers only what every Host can implement: collation (`compare` and `rank`), locale case (`upper` and `lower`), and locale data (`numberSymbols`, `monthNames` and `dayNames`), plus `tag`, which reports the locale in use. Every Operation is immediate. The Grant binds a default BCP 47 tag, and any call can name another. A well-formed tag the Host doesn't support falls back by lookup to one it does, ending at the root locale. A Script sorts by Collation by asking `rank` for each text's position and sorting with a Comprehension. Numbers are formatted and parsed by `text` Library functions written in the language, over the separators and digits `numberSymbols` gives. We chose this because a Standard Capability is only standard if every Host can offer it. Browser `Intl` has no sort keys and no number parser, and Go `x/text` has no number parser and no CLDR date patterns or names. Where a Host can supply data instead of behaviour, the behaviour is written once in the language. Parity then covers it (ADR 0009), and rounding, grouping and parse errors are the same everywhere. Only the facts that really are locale data vary by Host. Falling back the way `Intl` and ICU negotiate means a beginner's `"en-GB"` doesn't fail on a Host that only has `en`.

## Considered Options

- **A per-element sort key, as Bytes:** it fits `sorted by` directly, but browser `Intl.Collator` offers only `compare`, so a browser Host couldn't implement it.
- **A `sort` Operation returning the sorted texts:** simple, but it only sorts plain lists of text, not records by a field.
- **Only `compare`, with a merge sort written in the language:** this needs no new shape, but it puts O(n log n) calls into the Trace.
- **`rank` answering with a list aligned to its input:** a Comprehension has no index binding, so a Script couldn't use the list to sort records.
- **A Host `format` Operation for numbers:** simpler for a Script, but rounding of exact decimals would be Host-defined, and Go has no complete formatter.
- **A Host `parse` Operation for numbers:** neither `Intl` nor Go `x/text` has a number parser, so every Host would write its own.
- **Whole-date formatting in a locale ("29 September 2026"):** Go has no source for CLDR date patterns, and `formatDate` with names from `monthNames` covers the common case.
- **Raising `unknown locale` for any tag the Host lacks:** exact, but a Script written for `en-GB` would fail on a Host that has only `en`.
- **Tags only at Grant time:** a Script serving users in several locales couldn't do it, as ADR 0023 found for zones.
- **A silent fallback to code-point order and the Core's case mapping with no Grant:** a Script would sort differently on a Host without the Grant, and nothing would say so.
- **Names by width only:** some languages spell a month differently inside a date than on its own (Russian "29 сентября" against "сентябрь").

## Consequences

- **The Standard Capability:** narrows ADR 0021 and ADR 0023.
  - The Operations are `compare`, `rank`, `upper`, `lower`, `numberSymbols`, `monthNames`, `dayNames` and `tag`. All are immediate.
  - A Host that offers `locale` implements every Operation for every tag it resolves to. A Grant may still limit a Script to some of them (ADR 0012).
  - Each Host implements them with its own library (`Intl`, `x/text` with CLDR data, ICU) and sets their per-call cost. A Host may charge `rank` per element through `Charge` (ADR 0015).
  - The Trace records every answer, and a Trace Case supplies them as Stubs.
  - Operation names aren't stdlib names, so `locale`'s `upper` doesn't clash with the `upper` Built-in.
- **Call shape:**
  - Arguments come first, then an optional options map, then an optional trailing BCP 47 tag. The two optional arguments are told apart by kind, map against text.
  - For example: `ask locale to compare a, b, {sensitivity: "base"}, "de"`.
- **Naming a locale:**
  - The Grant binds a default tag, and any call can name another.
  - A tag that isn't well-formed BCP 47 raises `bad locale` with `{locale}`.
  - A well-formed tag the Host doesn't support falls back by lookup, dropping subtags from the right (`de-CH` → `de`), down to the root locale `und`, which every Host supports.
  - `tag` gives the tag in use, after fallback, as `calendar`'s `zone` does.
- **No Grant:** a Script with no `locale` Grant that calls it fails to load, as with any Capability (ADR 0012). There is no silent fallback. A Script that wants locale-free behaviour uses the Built-ins `upper` and `lower` and code-point `sorted by` (ADR 0011).
- **Collation:**
  - `compare a, b` gives -1, 0 or 1.
  - `rank texts` takes a list of text and gives a map from each distinct text to its rank: dense, 1-based, and shared by texts that compare equal.
  - Both take the options `sensitivity` (`"base"`, `"accent"`, `"case"` or `"variant"`, the default) and `numeric` (so "file 10" sorts after "file 9", false by default).
  - The Core checks `rank`'s answer: its keys must be exactly the distinct texts it was given, and its ranks dense. Any other answer ends the call with `host error`. A list element that isn't text raises `wrong kind`.
  - A Script sorts records by Collation with `every r in rs sorted by the (the name of r) of ranks`. The sort is stable, so texts of equal rank keep their input order.
- **Case:** `upper s` and `lower s` use the locale's case mapping, e.g. Turkish dotted İ. The Built-ins keep full default case mapping, and `ignoring case` keeps simple folding (ADR 0011).
- **Numbers:** narrows ADR 0021.
  - `numberSymbols` gives `{decimal, group, minus, digits, primaryGroup, secondaryGroup, minGrouping}`. `digits` is ten texts, zero first. `secondaryGroup` covers grouping such as `1,23,45,678`, and `minGrouping` the locales that write `1000` but `10.000`.
  - The `text` Library gains `formatNumber(n, symbols)`, `formatNumber(n, symbols, places)` and `parseNumber(t, symbols)`, written in the language.
  - Without `places`, `formatNumber` uses the digits of the canonical form, so trailing zeros survive. With `places`, it rounds half away from zero, as `round` does.
  - A Quantity raises `wrong kind`, so a Script formats the number part itself.
  - `parseNumber` must match the whole text: an optional minus, the locale's digits, and group separators either at every valid position or not at all. There is no exponent. A mismatch raises `can't convert` with `{value, format: "number", at}`.
- **Names:** narrows ADR 0023.
  - `monthNames` gives 12 texts, January first. `dayNames` gives 7 texts, Monday first, so `item weekday(d) of it` names a date's day.
  - Both take the options `width` (`"long"`, the default, `"short"` or `"narrow"`) and `form` (`"format"`, the default, for use inside a date, or `"standalone"`).
  - `formatDate`'s tokens stay numeric. A Script puts names into dates itself.
- **Left for later:**
  - Formatting currency Quantities in a locale.
  - Whole-date formatting in a locale's own pattern.
  - Title case.
- Narrowed by ADR 0025: Comprehensions are removed, so a Script sorts records by Collation with `sortBy(rs, given r: the (the name of r) of ranks)`. `rank` stays, since `sortWith` over `compare` would put one `locale` call per comparison in the Trace.
