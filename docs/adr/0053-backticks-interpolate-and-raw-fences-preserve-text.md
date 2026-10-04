# Backticks interpolate and raw fences preserve text

NorthTalk uses backticks for Interpolated Text with `${expression}` holes and fences of three or more double quotes for Raw Text Literals. A reusable Format Template uses `${key}` (or `${field:width}` for dates) and is filled explicitly. This replaces #273's proposed per-line markers: authors wanted to paste and read multiline content without marking every line or accidentally choosing the wrong interpolation mode.

## Considered Options

- Per-line `|` and `$`: local error recovery, but easy to forget which lines interpolate.
- A single interpolating line marker: still requires marking every pasted line.
- Only `format()`: preserves the old language but makes local expression interpolation cumbersome.
- JavaScript's exact whitespace preservation: familiar, but makes source indentation part of the value. Separate-line delimiters instead select an exact closing margin.

## Consequences

- Narrows ADR 0029: ordinary double-quoted text stays unchanged; new fenced forms may span lines, and backticks have JavaScript template escapes. An unclosed fence can consume the rest of the source; diagnostics point at its opener.
- Narrows ADR 0021 and ADR 0023: immediate interpolation is language syntax. Text and date Format Templates use dollar-brace placeholders and dollar doubling, with a clean migration from bare braces.
- Both forms remain ordinary NFC text. Interpolation inserts values once using `&`, with inherited Constant and Guard restrictions. Exact lowering and source positions belong to the Spec.
- Language `1.0-rc.2` records this breaking change. Cost Model 0 remains provisional: before language 1.0, lowering may change with a language prerelease revision without advancing Cost Model 0. Cost Model 1 remains reserved for calibration. Released Cost Models retain their version-change rule.
- The normative rules are in chapters 1, 2, 4, 7, 8 and 12. #274 records specification delivery, #275 Core and library delivery, and #276 tooling delivery.
