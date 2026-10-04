# 1. Lexical structure

_Draws on:_ [ADR 0011](../docs/adr/0011-text-is-nfc-grapheme-clusters-compared-exactly.md), [ADR 0013](../docs/adr/0013-binary-patterns-are-sequential-destructuring.md), [ADR 0019](../docs/adr/0019-one-predictive-grammar-with-contextual-keywords.md), [ADR 0022](../docs/adr/0022-compound-units-convert-into-the-left-operands-units.md), [ADR 0029](../docs/adr/0029-text-literals-have-no-escapes-and-line-breaks-are-built-in-constants.md), [ADR 0030](../docs/adr/0030-values-cross-the-host-boundary-as-tagged-values-converted-by-spec-rules.md), [ADR 0053](../docs/adr/0053-backticks-interpolate-and-raw-fences-preserve-text.md).

This chapter turns source text into tokens. [Chapter 2](02-grammar.md) turns tokens into a parse. The lexical productions are the `tokens` and `units` sections of [`grammar.ebnf`](data/grammar.ebnf), shown below.

## Source text

- **What source is:** a Script's or Library's source is a sequence of Unicode scalar values. Source the Host passes that isn't valid UTF-8 (Go) or that holds a lone surrogate (TS) is refused with the Host error `invalid value`, as for any text the Host supplies ([ADR 0030](../docs/adr/0030-values-cross-the-host-boundary-as-tagged-values-converted-by-spec-rules.md)).
- **No normalisation of the whole:** the Core doesn't normalise source. Outside text literals and comments, every token is ASCII. Each text literal is normalised to NFC when it becomes a value (below).
- **A byte order mark:** a U+FEFF at the very start of the source is ignored. Anywhere else it is a `bad character`.
- **Line breaks:** LF, CR LF and CR are each one line break, so `line` and the lexer agree on what a line is ([ADR 0011](../docs/adr/0011-text-is-nfc-grapheme-clusters-compared-exactly.md)).
- **Positions:** a source position is a line and a column, both counted from 1. A column counts Unicode scalar values from the start of its line, and a tab counts as one. Every diagnostic, and the source map ([chapter 8](08-the-abstract-machine-and-the-cost-model.md)), gives positions this way.

> **Rationale.** Scalar values need no Unicode tables and come out the same in Go and TS. Since tokens outside text and comments are ASCII, the unit only matters after non-ASCII text on the same line.

## Unicode

<!-- generated: unicode -->

The pinned Unicode version is **18.0.0**.

| UCD file | Used for | SHA-256 |
| --- | --- | --- |
| `UnicodeData.txt` | General Categories, for Text Pattern classes; canonical decompositions and combining classes, for NFC; simple case mappings | `0736451de439ae7baf1425136617da495e09ee5afbe6e394374db7009ea08950` |
| `CompositionExclusions.txt` | the composition exclusions, for NFC | `c759b100e9ae8960ae6b50fc5765950a7581fd9f30d4ef95f68f25a6d97e818e` |
| `CaseFolding.txt` | simple case folding (statuses C and S), for `ignoring case` | `a004797658a457bec4dc11683e39f69249ea3b595b752dbea6721c4c9f587b0d` |
| `SpecialCasing.txt` | the unconditional full case mappings, for the `upper` and `lower` Built-ins | `8538dea57c184f1ef3783885ea79677b10f6efa06423717157e63712f14d1ad2` |
| `PropList.txt` | White_Space, for `word` and the `word break` anchor | `f438f532e8737bb8a2702126cdf9c4af5e357c58c7acf9d9eb2fc7c1a1d955d6` |
| `DerivedCoreProperties.txt` | Indic_Conjunct_Break, for Character boundaries | `09c928886a178fcafd93c29e4bd59073a058e5a100b716d425cb563ab50f68c9` |
| `auxiliary/GraphemeBreakProperty.txt` | Grapheme_Cluster_Break, for Character boundaries | `0839dcb79e4ac639ecd538b1abf7c9d22e3f9dd265b7e182d33627aa4d75b45a` |
| `emoji/emoji-data.txt` | Extended_Pictographic, for Character boundaries | `80d00f8e616a0ef27fd6b8de3b758c06383b5d917e2977709578e68baf733bf1` |
| `auxiliary/GraphemeBreakTest.txt` | test data only: each Core's Character boundaries must pass it | `b0cf047ee94485bbdc846de2b902f5f8a815f6b674f9d04223cddadd91c9df31` |
| `NormalizationTest.txt` | test data only: each Core's NFC must pass it | `25a50d816764b04abfb4a646d3eb2b2a803284c3873d9a06757b94fe4513dde3` |

<!-- end -->

- **One version everywhere:** Character boundaries (UAX #29 extended grapheme clusters), NFC, simple case folding, full case mapping and the Text Pattern classes all follow the pinned version. The files are under `https://www.unicode.org/Public/<version>/ucd/`.
- **Generated tables:** each Core generates its tables from these files at build time, and a file whose SHA-256 doesn't match fails the build. No Core uses its platform's Unicode tables.
- **Upgrading** Unicode is a language version bump ([ADR 0011](../docs/adr/0011-text-is-nfc-grapheme-clusters-compared-exactly.md)).

## Tokens

<!-- generated: ebnf.tokens -->

```ebnf
Token          ::= Word | Number | Text | InterpolatedText | Unit | Punctuator | LineBreak
Word           ::= [A-Za-z_] [A-Za-z0-9_]*
Name           ::= Word  /* not a Reserved Word, and not `_` alone */
Number         ::= [0-9]+ ( '.' [0-9]+ )? | '0x' [0-9A-Fa-f]+
Text           ::= QuotedText | RawText | StaticBacktick
QuotedText     ::= '"' [^"#xA#xD]* '"'
RawText        ::= QuoteFence RawCharacter* QuoteFence
QuoteFence     ::= '"""' '"'*  /* maximal run; closing length must match */
RawCharacter   ::= [#x0-#x10FFFF]  /* excludes fence-length or longer quote runs */
StaticBacktick ::= '`' ( BacktickCharacter | TextEscape )* '`'
InterpolatedText ::= '`' ( BacktickCharacter | TextEscape | InterpolationHole )* '`'
BacktickCharacter ::= [^`#x5C]  /* excludes the start of ${ */
TextEscape     ::= #x5C ( EscapeCharacter | '0' | HexEscape | UnicodeEscape
                   | LineContinuation | IdentityEscapeCharacter )
                   /* '0' must not be followed by a decimal digit */
EscapeCharacter ::= [bfnrtv]
HexEscape      ::= 'x' HexDigit HexDigit
UnicodeEscape  ::= 'u' HexDigit HexDigit HexDigit HexDigit
                 | 'u{' HexDigit+ '}'  /* value at most #x10FFFF */
HexDigit       ::= [0-9A-Fa-f]
LineContinuation ::= LineBreak | #x2028 | #x2029
IdentityEscapeCharacter ::= [^0-9bfnrtvxu#xA#xD#x2028#x2029]
InterpolationHole ::= '${' Expression '}'  /* ordinary nested expression syntax */
Punctuator     ::= '...' | '..' | '&' | '=' | '<>' | '<=' | '>=' | '<<' | '>>'
                 | '<' | '>' | '+' | '-' | '*' | '/' | '^' | '(' | ')' | '['
                 | ']' | '{' | '}' | ',' | ':' | "'s"
LineBreak      ::= #xD #xA | #xA | #xD
Comment        ::= '--' [^#xA#xD]*
Space          ::= ( #x20 | #x9 )+
NL             ::= LineBreak  /* one that ends its line; the end of the source is one too */
CallOpen       ::= '('  /* straight after a Name, with nothing between */
PatternOpen    ::= '<'  /* in operand position, or inside a Text Pattern */
PatternClose   ::= '>'  /* inside a Text Pattern, always one character */
BinaryOpen     ::= '<<'  /* in operand position */
```

<!-- end -->

- **Longest match:** a token is the longest run of characters that forms one, so `...` is never `..` then `.`, and `<=` is never `<` then `=`.
- **Space and comments:** spaces and tabs separate tokens and are otherwise ignored. A comment runs from `--` to the end of its line, anywhere outside a text literal, so `5--3` is `5`. There are no block comments.
- **Words:** a Word is an ASCII letter or `_`, then letters, digits and `_`. Words are case-sensitive, and every Reserved Word is lowercase, so `Put` is a Name. A Name is a Word that isn't a Reserved Word ([chapter 2](02-grammar.md#reserved-words)). `_` alone is not a Name: it is the wildcard of Destructuring and of Binary Pattern fields.
- **Numbers:** a Number is decimal digits with an optional fraction (`42`, `2.50`), or `0x` and hexadecimal digits (`0x0D`), which is an integer. A Number has no sign, since `-` is an operator, no exponent and no leading `.`. Its digits are kept as written, so `2.50` keeps its trailing zero ([chapter 3](03-values.md)).
- **Punctuators:** the symbols in `Punctuator`. `'s` is a `'` followed by `s` that isn't followed by another Word character. Any other `'` is a `bad character`.
- **Anything else:** a character outside a text literal or comment that starts no token is a `bad character`, reported where it stands. So is any non-ASCII character there, such as the `ï` of `put naïve into x`.

## Text literals

These rules describe ordinary text enclosed by one double quote at each end (`"…"`). The fenced forms below have their own whitespace and escape rules.

- **Exactly what it shows:** a text literal is the characters between its double quotes. There are no escapes, so `"C:\new"` holds a backslash and an `n`, and `<"\d">` matches a backslash and a `d`.
- **One line:** a text literal can't contain a line break. Text with no closing quote before the end of its line is `unterminated text`, reported at the opening quote, and the scan of it ends at the line break.
- **NFC:** a text literal's value is the NFC normalisation of its characters, like all text ([ADR 0011](../docs/adr/0011-text-is-nfc-grapheme-clusters-compared-exactly.md)).
- **Line breaks, tabs and quotes** come from the Built-in Constants `newline` (LF), `tab` (U+0009) and `quote` (`"`), joined with `&`. They are names, not grammar ([chapter 7](07-libraries-and-the-standard-library.md)).
- **`return` is only a statement:** HyperTalk's `put a & return & b` is a syntax error at `return` ([chapter 2](02-grammar.md#statements)).

> **Example.**
>
> ```talk
> put "say " & quote & "hi" & quote & newline into shout
> put "C:\new" into path            -- 6 Characters
> ```

> **Rationale.** Escapes can't be added later without changing every literal that already holds a backslash, and an unterminated quote that swallowed the rest of the Script would put the first error far from the mistake ([ADR 0029](../docs/adr/0029-text-literals-have-no-escapes-and-line-breaks-are-built-in-constants.md)).

## Fenced text

Both forms produce ordinary text values; there is no separate template value kind.

A **Raw Text Literal** opens with a maximal run of at least three double quotes and closes with exactly that many quotes. Shorter runs are content; a longer run is `invalid text delimiter`. Choose a fence longer than every content run. Raw text has no escapes or interpolation. A run of six quotes is an opening fence, not an empty three-quote literal; use separate-line fences for empty raw text.

**Interpolated Text** opens and closes with a backtick. `${expression}` is an **Interpolation Hole**; other braces are literal. Holes use the ordinary expression grammar, including multiline expressions, comments, nested strings and nested interpolation. An empty hole is `empty interpolation`. Delimiters inside nested syntax do not close the containing hole or text.

Backticks use the following escapes, matching JavaScript template escape behavior:

- **Character escapes:** `\b`, `\f`, `\n`, `\r`, `\t` and `\v` produce U+0008, U+000C, U+000A, U+000D, U+0009 and U+000B respectively. `\0` produces U+0000 only when the next source character is not a decimal digit.
- **Hexadecimal and Unicode escapes:** `\xHH` has exactly two hexadecimal digits; `\uHHHH` has exactly four. `\u{H…}` has one or more hexadecimal digits and a value at most U+10FFFF. Hexadecimal digits are ASCII `0`–`9`, `A`–`F` or `a`–`f`.
- **Line continuation:** a backslash followed by physical LF, CRLF, CR, U+2028 or U+2029 contributes no character. A CRLF pair is one continuation.
- **Identity escapes:** a backslash followed by any other source scalar contributes that scalar alone. This includes escaped backslash, backtick and dollar; `\${` produces literal `${`, and `\q` produces `q`. The digits `1`–`9`, malformed `\x` or `\u` forms, and `\0` followed by a decimal digit are never identity escapes.

Malformed escapes and legacy octal forms are `invalid text escape`, reported at the offending backslash. An escaped high surrogate U+D800–U+DBFF followed in the decoded literal piece by a low surrogate U+DC00–U+DFFF forms one scalar; an unpaired surrogate is invalid. No escape is added to ordinary double-quoted text. Escape processing never introduces interpolation.

An immediate physical newline after either opener selects **margin-stripped form**. The closer must be preceded on its physical line only by spaces/tabs; ordinary code may follow it. That exact whitespace prefix is the margin. Remove the opening newline, the newline immediately preceding the closer's margin, and one margin prefix from each content line. A whitespace-only line shorter than the margin is allowed only when it is a prefix of the margin, and becomes empty. Otherwise report `invalid text indentation` at the first mismatching source position. Preserve remaining whitespace, additional blank lines and trailing spaces. Lines inside hole expressions use ordinary code rules; nested literals own their margins. An inline-start literal preserves all its content whitespace, even when it spans lines.

Physical LF, CRLF and CR become LF. Strip source margins before decoding escapes; explicit `\r` still produces CR. Normalize literal values and the results of interpolation joins to NFC, never source. Inserted values undergo neither dedentation nor escape processing.

Both forms are operands wherever an expression may start under the normal continuation rules. Raw text and hole-free backticks also satisfy every literal-only Text position. Backticks with holes are expressions, never computed literal keys or patterns.

At final EOF report `unterminated text` at the unfinished fence, or `unterminated interpolation` at `${`, choosing the innermost unfinished construct. Ordinary quoted text retains its line-local error rule. Recovery after the first diagnostic is non-normative.

## Lines

- **A line break ends a statement,** unless its line continues. There is no continuation character.
- **A line continues** past its line break while a bracket is open: `(`, `[`, `{`, the `<` of a Text Pattern or a `<<`. It also continues when its last token is a comma, or a binary operator in operator position: a symbol operator such as `+`, `&`, `=` or `..`, or one of `and`, `or`, `is`, `mod`, `div`, `contains` and `matches`. The second word of a two-word operator counts too: the `with` of `begins with` and `ends with`, and the `be` of `can be`. So does a `with` or `be` elsewhere in operator position, as in `replace … with` and `let … be`, since an expression must follow.
- **Lambdas:** a Lambda head, and the body of a block Lambda, make line breaks count again at the bracket depth where they start. So a block Lambda can be a call argument, a list item or a map value, and a bracket opened inside its body still continues lines as usual.
- **The end of the source** ends the last line, as a line break would.
- **Where a line ends:** the end-of-line token sits at the line break, after any trailing comment, or at the end of the source. An error reported "at the end of the line" is reported there.

> **Example.**
>
> ```talk
> put [1, 2,
>      3] into listed
> put "Total: " &
>     42 into label
> ```

> **Note.** A continued line moves some first errors down a line. `put [1, 2,` followed by a line `say x` is reported at `x`, and a trailing `and` before a line that starts with `wait` becomes `and wait`.

## Modes

The lexer is modal, and the parser drives it. For each token, the parser names the mode it is lexed in, which it always knows, since it knows whether it expects an operand or an operator. Only these characters change with the mode:

- **Operand position:** `<` opens a Text Pattern and `<<` opens a Binary Pattern, and both are brackets. `...` is spread or rest.
- **Operator position:** `<` is less-than, alongside `<=` and `<>`. `<<` is lexed, but no production accepts it, since there are no shift operators, so `put a << b into c` fails at `<<`. `>>` closes a Binary Pattern.
- **Inside a Text Pattern:** `<` opens a nested Text Pattern, and `>` closes one, always one character at a time, so `<one or more of <letter or digit>>` closes twice.
- **After a Number:** a Unit, if one starts there (below). Otherwise the token is lexed as in operator position.
- **After `as`:** a Compound Unit, if one starts there. Otherwise the token is lexed as in operand position.

The mode of every token is fixed before the parser decides anything on it, so no token is ever lexed twice.

## Units

<!-- generated: ebnf.units -->

```ebnf
Unit           ::= ( '1/' UnitFactor | UnitFactor ) ( ( '*' | '/' ) UnitFactor )*
                   /* straight after a Number, or after `as`; at most one `/` */
UnitFactor     ::= UnitName ( '^' [1-9] [0-9]* )?
UnitName       ::= [A-Za-z]+  /* a Unit's name or plural in units.toml; a Calendar Unit stands alone */
```

<!-- end -->

- **Only after a literal:** a Number followed by a Unit is a Quantity (`5 s`, `2.50 GBP`). Spaces between the two are optional. Nothing else takes a suffix, so `put 5 s into s` works, and `n kg` is two operands side by side. A variable converts with `n as kg` ([chapter 3](03-values.md)).
- **Where a Unit starts:** after a Number, a Unit starts at a Word that is a Unit's name or plural in [`units.toml`](data/units.toml), or at `1/`. Otherwise no Unit starts, so in `3 mod 2` the `mod` is an operator. After `as`, only a Compound Unit (one with a `*`, `/`, `^` or a leading `1/`) is a Unit token, and a single word there is a Name, since it may be a kind (`x as number`).
- **The longest match:** a Unit is the longest run of the Unit shape, with no spaces inside it. Then every factor must be a name or plural in `units.toml`, a Compound Unit has at most one `/`, an exponent is a positive integer, the factors of one Unit Kind name one Unit, since a Unit has one Unit in each slot ([chapter 3](03-values.md#compound-units)), and a Calendar Unit (`month`, `year`) stands alone, with no exponent. Anything else is `bad unit`, reported where the Unit starts.
- **Spaced symbols are arithmetic:** `500 mi / 4 hr` divides two Quantities, and `2 m*width` is `bad unit`, since `width` isn't a Unit.

> **Example.**
>
> ```talk
> put 60 mi/hr into speed           -- one Quantity
> put 9.81 m/s^2 into gravity
> put 5 1/s into rate               -- a Unit with only a denominator
> put 500 mi / 4 hr into average    -- 125 mi/hr
> put 3..7 m/s into comfortable     -- 3..(7 m/s)
> put 3 m/s..7 m/s into window      -- what was meant
> ```
>
> `put 5 s^-1 into rate`, `put 12 USD/month into rent` and `put 2 m*ft into area`, which names two length Units, are all `bad unit`. `2 m*m` is `2 m^2`, and `2 m * 3 ft` multiplies two Quantities and gives `1.8288 m^2`.

## Lexical errors

A lexical error is a syntax error, with one of the codes in [chapter 2](02-grammar.md#syntax-errors): `bad character`, `unterminated text` or `bad unit`. It is reported where its token starts, and the parse stops there.

## Outside parity

_None._
