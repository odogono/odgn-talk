
- Settled by #69: there is no source literal for Civil Dates or Instants. Scripts build them with `makeDate` and friends, or with `as civil date` and `as instant`.
  - The display form (ADR 0018) is ISO 8601: `2026-09-27` for a date only, `2026-09-27T14:30:00` for a date-time, and `2026-09-27T13:30:00Z` for an Instant, always in UTC. A fraction of a second appears only when it isn't zero, with up to nine digits and no trailing zeros.
  - `as text` gives the display form, and `as civil date` and `as instant` read it. `as instant` also reads a numeric offset (`+01:00`) and converts to UTC. `as civil date` refuses text with a `Z` or an offset, raising `can't convert`.
  - The display form needs only to read back in a Trace, as a Function Value's does (ADR 0025), not in source, where `2026-09-27` would lex as subtraction.
  - The `unconvertible-literal` Lint (ADR 0027) flags a literal text given to `as civil date` or `as instant` that can't convert.
