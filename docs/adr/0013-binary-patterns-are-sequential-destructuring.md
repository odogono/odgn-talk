# Binary Patterns are sequential Destructuring, not Text Patterns over bytes

Scripts match Bytes with a Binary Pattern, a Destructuring form next to `[…]` and `{…}`: `<< 0x02, id: uint32, x: int16 little, body: len bytes, ...rest >>`. It reads fields left to right, with sizes that are constant or computed from fields bound earlier in the same pattern, and it never searches or backtracks. It is a whole-value match unless it ends in `...` (discard) or `...rest` (bind the remaining Bytes). It is allowed anywhere Destructuring is, nested inside list and map patterns included. Values are built with the same brackets, but construction fields are `value as type` (`<< 0x02, id as uint32, x as int16 >>`), because inside a pattern `name:` always means "bind". We chose this because parsing binary data is almost always fixed layout, left to right. Sizes that depend on earlier fields aren't regular, so they don't fit the linear-time Text Pattern matcher (ADR 0007), but sequential Destructuring handles them in linear time. Integer fields with a byte order don't fit a Character vocabulary. And per-field reading lowers onto the Abstract Machine exactly like other Destructuring (ADR 0010).

## Considered Options

- **Extend Text Patterns to bytes.** One matcher, but it would mean searching and Character counting where neither applies, and length-prefixed fields would break linear-time matching.
- **Elixir's full bitstrings.** More general, but values that aren't whole bytes would leak into every operation on Bytes. Bit fields are allowed only in runs that add up to whole bytes.
- **Symmetric `name: type` for building, as Elixir does.** One syntax to learn, but `name:` would mean "bind" in a pattern and "use this value" in a build.
- **One instruction for the whole pattern**, as with Text Pattern matching. Cheaper to describe, but coarser Fuel that hides how many fields a failed clause test read.

## Consequences

- **Fields:** `uint8…uint64` and `int8…int64` bind Numbers (uint64 fits the 34-digit decimal exactly). They are big-endian by default, with a trailing `little` (or `big`). `n bits` fields are unsigned, MSB first, with constant sizes, and each run of them must add up to whole bytes, checked at load time. `n bytes` binds Bytes, and `n bytes as text` or `...rest as text` decodes by the same path as `as text` (strict UTF-8, then NFC, ADR 0011), where a failure to decode is no match. `_` skips a field. Literal numbers match one byte, and literal text matches its UTF-8.
- **Sizes** are an integer literal, a name bound earlier in the pattern, or a parenthesised arithmetic expression over those (a pinned outer variable in the advanced layer). A negative or non-integer size is no match, so a pattern stays pure and can run in a Guard region.
- **No float fields in v1.** A float64 has no exact decimal home and NaN/Infinity have nowhere to go (ADR 0002). Explicit, visibly lossy stdlib functions may cover it later.
- **No separate bytes literal.** `<<0x0D, 0x0A>>` is a build of constants, and as a pattern it matches those bytes. A hex-string decoder belongs in the stdlib.
- **Building:** a bare number is a uint8, text is its UTF-8, and a Bytes value is spliced in as is. A value that is out of range, non-integer or a Quantity is an error, never a wraparound.
- **Bytes is a value kind with chunks:** `byte n of b` is a Number 0..255, `bytes 2..5 of b` is Bytes, with ADR 0011's 1-based and read-past-end rules. `=` compares exactly, `<` is lexicographic unsigned, `the length of` counts bytes, and the canonical text form is the `<<0x…>>` literal. There is no data-size Unit Kind in v1, so `n bytes` is unambiguous inside `<< >>`.
- **Syntax:** `<<` and `>>` are tokens of their own, and the language has no shift operators.
- **Cost:** one Abstract Machine instruction per field, both when matching and when building, each charged a static base plus a per-byte term for copied or decoded fields. A failed clause test pays only for the fields it read.
