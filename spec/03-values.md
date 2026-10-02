# 3. Values

_Draws on:_ [ADR 0001](../docs/adr/0001-value-semantics.md), [ADR 0002](../docs/adr/0002-single-decimal-number-type.md), [ADR 0003](../docs/adr/0003-no-implicit-coercion.md), [ADR 0009](../docs/adr/0009-twin-cores-held-to-bit-for-bit-parity.md), [ADR 0011](../docs/adr/0011-text-is-nfc-grapheme-clusters-compared-exactly.md), [ADR 0013](../docs/adr/0013-binary-patterns-are-sequential-destructuring.md), [ADR 0016](../docs/adr/0016-messages-reach-scripts-through-core-owned-object-parents.md), [ADR 0018](../docs/adr/0018-the-trace-is-the-corpus-case.md), [ADR 0021](../docs/adr/0021-the-stdlib-is-a-small-built-in-core-plus-libraries-written-in-the-language.md), [ADR 0022](../docs/adr/0022-compound-units-convert-into-the-left-operands-units.md), [ADR 0023](../docs/adr/0023-named-time-zones-come-from-a-standard-capability.md), [ADR 0025](../docs/adr/0025-lambdas-are-first-class-function-values-that-run-in-their-home-script.md), [ADR 0030](../docs/adr/0030-values-cross-the-host-boundary-as-tagged-values-converted-by-spec-rules.md), [ADR 0033](../docs/adr/0033-the-error-catalogue-settles-its-fields-and-codes.md), [ADR 0034](../docs/adr/0034-numbers-never-have-a-positive-exponent-and-ranges-are-a-value-kind.md), [ADR 0036](../docs/adr/0036-a-ranges-ends-are-read-with-two-built-ins.md).

This chapter says what values there are, how they compare and how they convert. [Chapter 4](04-expressions-and-statements.md) says how expressions compute them, and [chapter 11](11-the-trace-and-conformance.md) gives the display form every value prints in.

## Kinds

Every value has exactly one kind:

| Kind | Holds | Made by |
| --- | --- | --- |
| `nothing` | Nothing, the one value meaning "no value here" | `nothing`, reading a missing key, a Capture that took no part |
| `boolean` | `true` or `false` | the literals, comparisons |
| `number` | a decimal ([below](#numbers)) | numeric literals, arithmetic |
| `quantity` | a number and a Unit | a numeric literal with a Unit, `as` with a Unit |
| `text` | a sequence of Characters, in NFC | text literals, `&`, chunks of text |
| `bytes` | a sequence of 8-bit values | `<< … >>`, `as bytes` |
| `list` | a sequence of values, counted from 1 | `[…]` |
| `map` | values under text keys, in insertion order | `{…}` |
| `range` | two ends, both numbers or both Quantities | `..` |
| `instant` | a point on the timeline, to the nanosecond | `as instant`, the `clock` and `calendar` Capabilities |
| `civil date` | a calendar date, with an optional time of day | `as civil date`, the `date` Library |
| `pattern` | a Text Pattern | `<…>` |
| `function` | a Function Value | a Lambda, a function's bare name |
| `object` | a Host Object | the Host only |

- **Kind names:** the names in the first column are what `is a` tests, what `as` and `can be` convert to where a conversion exists, and what an error's `expected` and `got` fields hold ([chapter 6](06-errors-and-limits.md)). `integer` is also allowed after `is a` or `is not a`, and as `expected` where an integer is needed ([below](#integers)). After `as` and `can be`, so is a Unit. Any other name there is a load error.
- **Reading a kind:** the Built-in `kindOf(x)` gives the kind name of any value as text, so `kindOf(3)` is `"number"` ([chapter 7](07-libraries-and-the-standard-library.md#values), [ADR 0043](../docs/adr/0043-values-are-introspected-through-built-in-functions.md)).
- **No value changes kind by itself** ([ADR 0003](../docs/adr/0003-no-implicit-coercion.md)). A Script converts with `as`. The one automatic conversion is to text, by `&`, `put`, `say` and `format` ([the text form](#the-text-form)).
- **Plain data:** every kind except `object` is plain data. It has no identity, and a Script Snapshot saves it as it is ([ADR 0025](../docs/adr/0025-lambdas-are-first-class-function-values-that-run-in-their-home-script.md)).

## Value Semantics

- **No Script value is both shared and changeable.** Putting into a Container rebinds its root variable ([chapter 4](04-expressions-and-statements.md#containers)), so the change is never seen through another name, a Handler argument, a sent value, a suspended Run, a Function Value's captures or a loop's subject.
- **Host Objects** are the only values with identity. Copying one copies the handle, never the thing it stands for, and a Script can't make one.
- **Representation:** a Core may share values, copy on write or use persistent structures, as long as no Script and no Trace can tell. Memory is charged on logical size, as if nothing were shared ([chapter 8](08-the-abstract-machine-and-the-cost-model.md)).

> **Example.**
>
> ```talk
> put ["apples", "pears"] into fruit
> put fruit into basket
> put "kiwis" into item 1 of basket
> say item 1 of fruit               -- apples
> ```

## Equality

`=` and `is` test equality, and `<>` and `is not` test its opposite.

- **It never errors.** Values of two different kinds are unequal, so `1 = "1"`, `5 = 5 kg` and `nothing = ""` are all `false`.
- **Numbers** are equal by value, so `1.0 = 1`.
- **Quantities** are equal when their dimensions match and their values in Base Units are equal: `5 kg = 5000 g` and `1 L = 1000 mL`. Quantities of different dimensions are unequal, so `5 kg = 5 m` is `false`, and so is a calendar duration against an exact one.
- **Text** is equal Character by Character, exactly, so case matters. Since text is always NFC, canonically equivalent texts are equal. With `ignoring case`, the simple case foldings are compared instead ([Text](#text)).
- **Bytes** are equal when every byte is.
- **Lists** are equal when they have the same length and equal elements in order.
- **Maps** are equal when they have the same keys and equal values under each key. Order doesn't count.
- **Ranges** are equal when both ends are.
- **Instants** are equal when they are the same point. **Civil Dates** are equal when every field is, so a date-only value never equals a date-time.
- **Text Patterns** are equal when their canonical sources are ([chapter 11](11-the-trace-and-conformance.md)).
- **Function Values** are equal when they have the same Home Script, come from the same Lambda or named function, and have equal captured values ([ADR 0025](../docs/adr/0025-lambdas-are-first-class-function-values-that-run-in-their-home-script.md)).
- **Host Objects** are equal when they are the same object, disposed or not.
- **Booleans and Nothing** are each equal only to themselves.

This one equality is used everywhere: by Destructuring literals, map keys, `is in` over a list, `match` and Guards.

## Ordering

`<`, `>`, `<=` and `>=` order two values, and so does every sort.

- **Numbers** by value.
- **Quantities** of one dimension, by value in Base Units.
- **Text** by the code points of its NFC form, compared in turn, with a prefix before the longer text. This is not Collation, which comes from the `locale` Capability ([chapter 7](07-libraries-and-the-standard-library.md)). With `ignoring case`, the simple case foldings are ordered instead.
- **Bytes** by byte, unsigned, with a prefix first.
- **Instants** by time. **Civil Dates** by time, when both are date-only or both are date-times.
- **Lists** element by element. The first pair of elements that aren't equal decides, by `<`, and a list that is a prefix of another comes first.
- **Anything else** raises `can't compare`, with the two operands as `left` and `right`: values of two kinds, Quantities of two dimensions, a date-only value and a date-time, and any two values of a kind that isn't ordered (boolean, Nothing, map, range, pattern, function and object). For lists, it is raised for the first unequal pair, if that pair can't be ordered.
- **`<=` and `>=`** raise exactly when `<` would, and otherwise mean `<` or `=`.

> **Example.**
>
> ```talk
> if [1, "b"] < [2, "a"] then say "the first elements decide"
> if [1, 2] < [1, 2, 0] then say "a prefix comes first"
> if "Zebra" < "apple" then say "code-point order: Z is before a"
> ```
>
> `1 < "1"` raises `can't compare`, and so does `[1, "a"] < [1, 2]`, at its second pair.

## Conversion

`x as K` converts `x` to the kind `K`, and `x as U` to the Unit `U`:

| Target | From | Gives |
| --- | --- | --- |
| `text` | Bytes | their UTF-8 decoding, then NFC. Bytes that aren't strict UTF-8 raise `can't convert` |
| `text` | any other value | its [text form](#the-text-form) |
| `number` | text | the number it spells, in the [number syntax](#reading-numbers) |
| `number` | a number | the same number |
| a Unit | a number | a Quantity in that Unit |
| a Unit | a Quantity | the Quantity converted into that Unit, if the dimensions match |
| a Unit | text | the number or Quantity it spells, then converted as above |
| `bytes` | text | its UTF-8 encoding |
| `bytes` | Bytes | the same Bytes |
| `civil date` | text | the Civil Date it spells ([Dates and times](#dates-and-times)) |
| `civil date` | a Civil Date | the same Civil Date |
| `instant` | text | the Instant it spells, converted to UTC |
| `instant` | an Instant | the same Instant |

- **Failure:** any other value raises `can't convert` with `{value, to}`, where `to` is the kind name or the Unit's display form. So does text that doesn't spell a value of the target, and a Quantity whose dimension isn't the Unit's. A Quantity isn't a number: `5 kg as number` raises, and `q / 1 kg` gives the plain number.
- **Kinds with no conversion:** `as` with any other kind name (`list`, `map`, `boolean`, `range`, `pattern`, `function`, `object`, `nothing` or `quantity`) is a load error. Text is never evaluated as code.
- **Quantities in text:** text read by `as` with a Unit is the number syntax, then optionally spaces and a Unit spelled as in source, such as `"5 kg"` or `"60 mi/hr"`. Without a Unit it reads as a plain number.
- **White space:** converting text to a number, a Unit, a Civil Date or an Instant ignores White_Space Characters at either end.
- **`can be`:** `x can be a K`, and `x can be U` with a single-word Unit, is `true` exactly when `x as K` or `x as U` would succeed, and it never raises.
- **`is a`:** `x is a K` is `true` exactly when the kind of `x` is `K`. So `"42" is a number` is `false`.
- **`is empty`** is `true` for empty text, an empty list, an empty map and empty Bytes, and `false` for every other value, Nothing included.

> **Example.**
>
> ```talk
> put "007" as number into n        -- 7
> put " 2.50 " as number into price  -- 2.50
> put "5 kg" as g into mass         -- 5000 g
> put 3 as kg into w                -- 3 kg
> put 60 mi/hr as km/hr into limit  -- 96.56064 km/hr
> if "lots" can be a number then say "never"
> ```
>
> `"5 kg" as number`, `"1e3" as number` and `"+1" as number` all raise `can't convert`.

## The text form

`&`, `put` into text, `say`, `format` and `as text` show a value as text, except that `as text` decodes Bytes instead:

- **Text** is itself, without quotes.
- **Every other value** is its display form ([chapter 11](11-the-trace-and-conformance.md)), so it reads back in a Trace. For the kinds in this chapter:
  - Nothing is `nothing`, and the booleans are `true` and `false`.
  - A number is its [canonical text](#the-text-of-a-number), and a Quantity is that, one space, then its [Unit](#printing-quantities).
  - A range is its two ends joined by `..`, such as `3..7` or `3 m/s..7 m/s`.
  - A Civil Date or an Instant is its [ISO 8601 form](#dates-and-times).
  - Bytes are their `<<…>>` build, such as `<<0x0D, 0x0A>>`.
  - Lists, maps, Text Patterns, Function Values and Host Objects print as chapter 11 says. Text inside them is quoted, so `"a" & ["b"]` gives `a["b"]`.

> **Rationale.** The conversion to text is total and can't be ambiguous, so it is the one conversion that happens by itself ([ADR 0003](../docs/adr/0003-no-implicit-coercion.md)).

## Nothing and booleans

- **Nothing** is one value, distinct from empty text, an empty list and an empty map. It is what a missing key, a Capture that took no part and a bare `return` give. A list or a map may hold it. `x is nothing` is `x = nothing`.
- **Booleans** are `true` and `false`. No other value stands in for one: a condition, a Guard and each operand of `and`, `or` and `not` must be a boolean ([chapter 4](04-expressions-and-statements.md#evaluation)).

## Numbers

There is one number kind, a decimal, defined here so that both Cores give the same result bit for bit ([ADR 0002](../docs/adr/0002-single-decimal-number-type.md), [ADR 0034](../docs/adr/0034-numbers-never-have-a-positive-exponent-and-ranges-are-a-value-kind.md)).

- **What a number is:** a sign, a coefficient of at most 34 decimal digits, and an exponent from −6176 to 0. Its value is the coefficient times ten to the exponent, negated if the sign is negative.
- **The exponent is part of the value.** `2.50` and `2.5` are equal, but they print differently, and a numeric literal keeps its digits as written. So arithmetic keeps trailing zeros: `2.50 * 3` gives `7.50`.
- **No special values:** there is no NaN, no Infinity and no negative zero. A zero result is `0`, with its exponent kept, so `-0.00` is `0.00`.

### Arithmetic

Each operator's result is found in three steps:

1. **Round:** take the exact result, and round it half-even, once, to 34 significant digits, or at exponent −6176 if that keeps fewer digits.
2. **Check the size:** a rounded result of 10^34 or more in magnitude raises `overflow`, with the operator as `operator` (`"*"`, say).
3. **Pick the exponent:** of the ways to write that value with at most 34 digits and an exponent from −6176 to 0, take the one whose exponent is nearest the operator's ideal exponent, below. So an ideal exponent above 0 gives exponent 0.

| Operator | Ideal exponent |
| --- | --- |
| `a + b`, `a - b` | the smaller of the two operands' exponents |
| `a * b` | the sum of the two exponents |
| `a / b` | the exponent of `a` minus that of `b` |
| `a div b` | 0 |
| `a mod b` | the smaller of the two exponents |
| `a ^ n`, for an integer `n` | `n` times the exponent of `a` |
| `-a` | the exponent of `a` |

- **Division:** `a / b`, `a div b` and `a mod b` raise `division by zero` when `b` is zero.
- **`div` and `mod`:** `a div b` is the integer part of the exact quotient, rounding toward zero. `a mod b` is the exact value of `a - (a div b) * b`, so it has the sign of `a`: `7 mod 3` is `1`, `-7 mod 3` is `-1` and `7.5 mod 2` is `1.5`.
- **`^`:** `a ^ n` for an integer `n` is the exact power, found by the steps above, and `a ^ 0` is `1`. A negative `n` gives `1 / (a ^ -n)`, so `0 ^ -1` raises `division by zero`. For any other exponent, `a ^ b` is `power(a, b)` ([chapter 7](07-libraries-and-the-standard-library.md)).
- **Kinds:** these operators take numbers. [Quantities](#quantity-arithmetic) and [dates](#date-arithmetic) have their own rules, and any other operand raises `wrong kind`, as `"007" + 1` does.

> **Example.**
>
> ```talk
> put 0.1 + 0.2 into a              -- 0.3
> put 2.50 * 3 into b               -- 7.50
> put 10 / 4 into c                 -- 2.5
> put 7.50 / 3 into d               -- 2.50
> put 1 / 0.01 into e               -- 100
> put 1 / 3 into f                  -- 0.3333333333333333333333333333333333
> put 2 / 3 into g                  -- 0.6666666666666666666666666666666667
> put 2 ^ 10 into h                 -- 1024
> ```

> **Rationale.** A positive exponent would print as `1E+2`, which the literal syntax can't read, or as `100`, which reads back as a different number: after `* 1.0`, one gives `100` and the other `100.0`. With no positive exponents, every number prints in the literal syntax and reads back as itself ([ADR 0034](../docs/adr/0034-numbers-never-have-a-positive-exponent-and-ranges-are-a-value-kind.md)).

### Integers

- **No integer kind:** `x is an integer` is `true` for a number with no fractional part, whatever its exponent, so `3.0 is an integer`. It is `false` for every value that isn't a number.
- **Where an integer is needed**, such as a chunk index, a `repeat` count, a range walked by `repeat for each` or a Binary Pattern build field, a number with a fractional part raises `wrong kind` with `expected` `"integer"`.

### The text of a number

A number's canonical text is plain notation, and never uses an exponent:

- a `-` if it is negative,
- then its integer digits, with no leading zeros, and `0` if there are none,
- then, if its exponent is negative, a `.` and exactly as many fraction digits as the exponent says.

So `7.50`, `0.3`, `100`, `0.00`, `-2.5` and `0.0000001` are all canonical.

### Reading numbers

The number syntax is what a numeric literal ([chapter 1](01-lexical-structure.md#tokens)) and `as number` read, and what a Host's `Dec` accepts ([chapter 9](09-embedding.md)):

- decimal digits, optionally followed by `.` and more digits, keeping every digit as written, or
- `0x` and hexadecimal digits, which spell an integer with exponent 0.

`as number` also allows one `-` before the digits. There is no `+`, no exponent, no group separator and no leading `.`. Leading zeros are allowed and dropped, so `"007"` reads as `7`.

- **Limits:** a number with more than 34 significant digits, a magnitude of 10^34 or more, or more than 6176 fraction digits doesn't convert. In source it is a load error, and `as number` raises `can't convert`.
- **Nothing is rounded on the way in,** so every number reads back as itself.

## Quantities

A Quantity is a number together with its Unit, and the Unit is part of the value: `5 kg` and `5` are different values ([ADR 0022](../docs/adr/0022-compound-units-convert-into-the-left-operands-units.md)).

### The Unit Catalogue

The Unit Catalogue is [`units.toml`](data/units.toml). The language version pins it, and neither Hosts nor Scripts can add to it. Its Unit Kinds, in the order that Units print in:

<!-- generated: units.kinds -->

| Unit Kind | Base Unit | Dimension |
| --- | --- | --- |
| mass | `kg` | mass |
| length | `m` | length |
| volume | `L` | length^3, with `L` = 0.001 |
| exact duration | `s` | time |
| calendar duration | `month` | none (Calendar Units) |
| temperature difference | `degC` | temperature |
| USD | `USD` | USD |
| EUR | `EUR` | EUR |
| GBP | `GBP` | GBP |
| JPY | `JPY` | JPY |
| CHF | `CHF` | CHF |
| CNY | `CNY` | CNY |
| CAD | `CAD` | CAD |
| AUD | `AUD` | AUD |
| INR | `INR` | INR |
| SEK | `SEK` | SEK |

<!-- end -->

Its Units:

<!-- generated: units.units -->

| Unit | Plural | Unit Kind | Factor to the Base Unit |
| --- | --- | --- | --- |
| `mg` |  | mass | 0.000001 |
| `g` |  | mass | 0.001 |
| `kg` |  | mass | 1 |
| `lb` |  | mass | 0.45359237 |
| `oz` |  | mass | 0.028349523125 |
| `mm` |  | length | 0.001 |
| `cm` |  | length | 0.01 |
| `m` |  | length | 1 |
| `km` |  | length | 1000 |
| `inch` | `inches` | length | 0.0254 |
| `ft` |  | length | 0.3048 |
| `yd` |  | length | 0.9144 |
| `mi` |  | length | 1609.344 |
| `mL` |  | volume | 0.001 |
| `L` |  | volume | 1 |
| `ms` |  | exact duration | 0.001 |
| `s` |  | exact duration | 1 |
| `min` |  | exact duration | 60 |
| `hr` |  | exact duration | 3600 |
| `day` | `days` | exact duration | 86400 |
| `week` | `weeks` | exact duration | 604800 |
| `month` | `months` | calendar duration | 1 |
| `year` | `years` | calendar duration | 12 |
| `degC` |  | temperature difference | 1 |
| `degF` |  | temperature difference | 5/9 |
| `USD` |  | USD | 1 |
| `EUR` |  | EUR | 1 |
| `GBP` |  | GBP | 1 |
| `JPY` |  | JPY | 1 |
| `CHF` |  | CHF | 1 |
| `CNY` |  | CNY | 1 |
| `CAD` |  | CAD | 1 |
| `AUD` |  | AUD | 1 |
| `INR` |  | INR | 1 |
| `SEK` |  | SEK | 1 |

<!-- end -->

- **Spellings:** each Unit has one spelling. A word Unit also has a plural, and both forms are accepted everywhere. There are no synonyms, so there is no `h` or `sec`.
- **Dimensions:** every Unit is an exact factor times a product of base dimensions: length, mass, time, temperature, and one for each currency. A volume is length³, and `L` is 0.001 m³. The Calendar Units, `month` and `year`, have a dimension of their own, outside the base dimensions. They convert only into each other, and never appear in a Compound Unit.
- **Factors** are exact decimals, except `degF`, whose factor is the ratio 5/9.
- **Currencies:** the ten currency Units are each a Unit Kind and a dimension of their own, and nothing converts between them. An exchange rate is a Quantity, such as `1.1 USD/EUR`. There is no rounding to a currency's minor unit, so `1.005 USD` stays exact.
- **Temperatures** are differences only. The `units` Library converts absolute temperatures, as plain numbers ([chapter 7](07-libraries-and-the-standard-library.md)).

### Compound Units

- **Written** with factors joined by `*`, at most one `/` before the denominator, and positive integer exponents after `^`, with no spaces: `kg*m/s^2`, `mi/hr`, `1/s` ([chapter 1](01-lexical-structure.md#units)).
- **Slots:** a Quantity's Unit has at most one Unit in each slot, with an exponent that is positive in the numerator and negative in the denominator. The slots are the Unit Kinds above. So `L` and `mL` share the volume slot, and `m` has the length slot, even though a volume is length³.
- **Normal form:** a slot whose exponent comes to zero is dropped. Numerator factors print first, in Kind order, then a `/` and the denominator factors, in Kind order. An exponent of 1 isn't written, and a Unit with only a denominator is written `1/s`.
- **No Unit left:** a result whose slots have all dropped is a plain number, so `4 yd / 2 ft` gives `6`.
- **Calendar Units** stand alone. A result that would put a Calendar Unit beside another factor, or give it an exponent other than 1, raises `incompatible units`.

### Converting

Arithmetic and `as` go through Base Units ([ADR 0022](../docs/adr/0022-compound-units-convert-into-the-left-operands-units.md)):

- **A Unit's factors:** its numerator factors are the factors of its numerator Units, in Kind order, each as many times as its exponent. Its denominator factors are the same for its denominator. A volume Unit also has the 0.001 of `L` as a factor, and `degF` has 5 as a numerator factor and 9 as a denominator factor.
- **Into Base Units:** a value is multiplied by each numerator factor in turn, then divided by each denominator factor in turn.
- **Out of Base Units:** a value is multiplied by each denominator factor in turn, then divided by each numerator factor in turn.
- **Every step is rounded** as the arithmetic above says. No other rule removes digits, so trailing zeros that a factor adds stay ([ADR 0034](../docs/adr/0034-numbers-never-have-a-positive-exponent-and-ranges-are-a-value-kind.md)).

> **Rationale.** Going through Base Units makes `4 yd / 2 ft` compute `3.6576 / 0.6096`, which is exactly `6`. Converting `ft` straight into `yd` would multiply by a third.

### Quantity arithmetic

- **`+` and `-`** take two Quantities of one dimension, and the result is in the left operand's Unit. Quantities of two dimensions, or a calendar and an exact duration, raise `incompatible units`, with the two Units' display forms as `left` and `right`. A number and a Quantity raise `wrong kind`.
- **`*` and `/`** take any two Quantities, or a Quantity and a number. A number takes part as a Quantity with no Unit. The result's Unit starts as the left operand's. Then, for each slot of the right operand, the right operand's Unit converts into the Unit the left operand already has in that slot, and the exponents add. If the left operand has nothing in that slot, the right operand's Unit is kept. The value is the product or quotient in Base Units, converted into the result's Unit.
- **`^`** raises a Quantity to a positive integer power, multiplying each exponent by it. Any other exponent raises `wrong kind` with `expected` `"integer"`, and a Quantity as the exponent raises it with `expected` `"number"`.
- **A result's Unit** that breaks the rule for Calendar Units raises `incompatible units`, as for `1 / 2 month` or `(1 month) ^ 2`. A plain number taking part has the Unit `1` in the fields.
- **Unary `-`** negates the number and keeps the Unit.
- **`div` and `mod`** take numbers only, and a Quantity raises `wrong kind`.
- **Comparing** Quantities follows [equality](#equality) and [ordering](#ordering).
- **`as` with a Unit** converts a Quantity whose dimension matches, and a Calendar Unit converts only into the other Calendar Unit. Given a plain number, `as` attaches the Unit, and nothing else relabels one. A value that would pass the number limits in the new Unit raises `can't convert`.

> **Example.**
>
> ```talk
> put 5 kg + 250 g into heavier     -- 5.250 kg
> put 90 min + 1 day into later     -- 1530 min
> put 500 mi / 4 hr into speed      -- 125 mi/hr
> put speed as km/hr into metric    -- 201.168 km/hr
> put 2 m * 3 ft into area          -- 1.8288 m^2
> put 2 m * 3 s into a2             -- 6 m*s
> put 3 kg * 2 m into a3            -- 6 kg*m, in Kind order
> put 4 L / 2 m into a4             -- 2 L/m
> put 2 L * 2 L into a5             -- 4 L^2
> put 1 / 2 s into rate             -- 0.5 1/s
> put 10 USD / 2 EUR into fx        -- 5 USD/EUR
> put 100 EUR * 1.1 USD/EUR into p  -- 110.0 USD
> put 60 mi/hr * 2 hr into far      -- 120.0 mi
> put 9 degF as degC into warmer    -- 5 degC
> put 24 m^3 as L into tank         -- 24000 L
> ```
>
> `5 kg + 3`, `5 kg + 2 m` and `1 month + 1 day` all raise.

### Printing Quantities

A Quantity's text form is its number's canonical text, one space, then its Unit in normal form.

- **Plurals:** a word Unit standing alone is singular when the number's magnitude is exactly 1 (`1 day`, `1.0 day`, `-1 day`) and plural otherwise (`3 days`, `0 days`).
- **Inside a Compound Unit,** every Unit is singular: `5 inch/s`.
- **A range** of Quantities prints both ends in full: `3 m/s..7 m/s`.

## Text

- **Characters:** text is a sequence of Characters, each an extended grapheme cluster under the pinned Unicode version ([chapter 1](01-lexical-structure.md#unicode)). Lengths, positions and ranges count Characters.
- **Always NFC:** every text value is in NFC. A text literal is normalised when it becomes a value, a Host's text when the Host builds it, uncharged ([ADR 0030](../docs/adr/0030-values-cross-the-host-boundary-as-tagged-values-converted-by-spec-rules.md)), and the result of every operation that joins or edits text, such as `&` or a chunk write, is normalised again.
- **Exact comparison:** `=`, map keys, Destructuring literals and Text Patterns are case-sensitive, and there is no hidden state such as a case or delimiter setting ([ADR 0011](../docs/adr/0011-text-is-nfc-grapheme-clusters-compared-exactly.md)).
- **`ignoring case`** compares the simple case foldings of the texts (statuses C and S of `CaseFolding.txt`), with no locale. It folds text only: in a Text Pattern, `uppercase letter` keeps its meaning.
- **Whole Characters:** a search for text matches only on whole-Character boundaries, so `"👨‍👩‍👧" contains "👧"` is `false`.
- **Case mapping and Collation** are Built-ins and the `locale` Capability, never operators ([chapter 7](07-libraries-and-the-standard-library.md)).

Chunks of text (`word 2 of s`) are in [chapter 4](04-expressions-and-statements.md#chunk-expressions).

## Bytes

- **Bytes** is a sequence of values from 0 to 255. Its length and positions count bytes, never Characters ([ADR 0013](../docs/adr/0013-binary-patterns-are-sequential-destructuring.md)).
- **Comparison:** `=` compares every byte, and `<` is lexicographic, unsigned.
- **Text:** `as text` decodes strict UTF-8 and then normalises to NFC, and `as bytes` encodes text as UTF-8. Strict UTF-8 refuses overlong forms, surrogates and truncated sequences, and a leading byte order mark decodes as U+FEFF like any other. Other encodings are functions in the `bytes` Library.
- **Chunks:** `byte n of b` is a number, and `bytes 2..5 of b` is Bytes ([chapter 4](04-expressions-and-statements.md#chunk-expressions)).
- **Building and matching** use Binary Patterns ([chapter 4](04-expressions-and-statements.md#binary-patterns)).

## Lists and maps

- **Lists** hold any values, Nothing and other lists included, counted from 1.
- **Maps** hold values under text keys. Keys are compared exactly, after NFC, so they are case-sensitive.
- **Insertion order:** a map's keys are in the order they were added. A literal adds them in the order written, putting under a new key adds it last, putting under an existing key keeps its place, and deleting a key removes it. `the keys of m` and `the values of m` follow this order, and `=` ignores it.
- **Duplicate keys:** a map literal that names a key twice is a load error.
- **Reading a missing key** gives Nothing. A key whose value is Nothing is still a key, so `{a: nothing}` isn't equal to `{}`.

## Ranges

A range is two ends made with `..`, both numbers, or both Quantities of one dimension ([ADR 0034](../docs/adr/0034-numbers-never-have-a-positive-exponent-and-ranges-are-a-value-kind.md)).

- **Making one:** ends of any other kind raise `wrong kind`, and Quantities of two dimensions raise `incompatible units`. Each end is kept as written, and a range whose first end is past its second is a range like any other.
- **Membership:** `x is in a..b` means `a <= x and x <= b`, so an `x` that can't be ordered against the ends raises `can't compare`.
- **Integer ranges:** a range whose ends are both integers also reads like the list of its integers, from the first end up to the second. `the length of (5..7)` is `3`, `item 1 of (5..7)` is `5`, and `the items of (5..7)` is `[5, 6, 7]`. The brackets are needed, since `..` binds looser than `of`. A reversed integer range has length `0`.
- **Its ends:** the Built-ins `rangeStart(r)` and `rangeEnd(r)` read the two ends of any range as written, so `rangeStart(5..4)` is `5` even though `item 1 of (5..4)` is Nothing ([chapter 7](07-libraries-and-the-standard-library.md#values), [ADR 0036](../docs/adr/0036-a-ranges-ends-are-read-with-two-built-ins.md)).
- **Walking and chunks:** `repeat for each` walks an integer range, and chunk indexes take one ([chapter 4](04-expressions-and-statements.md)).
- **Comparison:** ranges are equal when both ends are, and they aren't ordered.
- **At the Host,** a range is its own kind, `range` ([chapter 9](09-embedding.md)).

> **Example.**
>
> ```talk
> put 3 m/s..7 m/s into comfortable
> if 5 m/s is in comfortable then say "fine"
> if 200 is in 200..299 then say "ok"
> put the items of (1..3) into steps  -- [1, 2, 3]
> ```
>
> `3..7 m/s` is `3..(7 m/s)` ([chapter 1](01-lexical-structure.md#units)), which raises `wrong kind`.

## Dates and times

There are two kinds, and the Cores hold no time-zone data ([ADR 0023](../docs/adr/0023-named-time-zones-come-from-a-standard-capability.md)):

- **An Instant** is a point on the global timeline, to the nanosecond, with no leap seconds. It has no fields until a Script turns it into a Civil Date, with the `toCivil` Built-in or the `calendar` Capability ([chapter 7](07-libraries-and-the-standard-library.md)).
- **A Civil Date** is a date in the proleptic Gregorian calendar (year, month and day), with an optional time of day (hour, minute, second and nanosecond), and no zone. A date-only value and a date-time are one kind, but they never compare against each other.
- **The range** is 0001-01-01 to 9999-12-31, for a Civil Date and, in UTC, for an Instant. Construction, parsing or arithmetic outside it raises `out of range`, with `field` `"year"` and the year as `value`.
- **No literal:** a Script builds dates with `as civil date`, `as instant` and the `date` Library, and reads the time through the `clock` Capability.

### Date arithmetic

| Left | Operator | Right | Result |
| --- | --- | --- | --- |
| an Instant | `+`, `-` | an exact duration | an Instant |
| a date-time | `+`, `-` | an exact duration | a date-time |
| a date-only value | `+`, `-` | an exact duration of whole days | a date-only value |
| a Civil Date | `+`, `-` | a calendar duration of whole months | a Civil Date |
| an Instant | `-` | an Instant | an exact duration in `s` |
| a date-time | `-` | a date-time | an exact duration in `s` |
| a date-only value | `-` | a date-only value | a whole number of `days` |

- **No zones:** Civil arithmetic knows no zone, so every day is 86400 s long.
- **Calendar durations** count months, and a year is 12 of them. Adding one moves the year and month, then clamps the day to the last day of that month, and keeps the time of day, so `2026-01-31` plus `1 month` is `2026-02-28`.
- **Exact durations** are taken to whole nanoseconds, rounded half-even.
- **Differences** are exact, written with no more decimal places than they need, and at most nine. So two Instants 90 seconds apart give `90 s`.
- **Errors:**
  - An Instant plus a calendar duration, a date-only value plus an exact duration that isn't a whole number of days, and a Civil Date plus a calendar duration that isn't a whole number of months all raise `incompatible units`. So does a date plus a Quantity of any other dimension. `left` is the Unit the date takes, `s` for an Instant or a date-time and `day` for a date-only value, or `month` for a calendar duration that isn't whole months, and `right` is the Quantity's Unit.
  - A date-only value against a date-time, an Instant against a Civil Date, two dates added, and a date with a plain number raise `wrong kind`. So does a duration on the left of a date. `expected` is `"quantity"` for what is added to a date, the left date's kind for what is subtracted from one, and `"quantity"` or `"number"`, after the left operand, for a date on the right. Every other operator on a date raises it with `"number"`.

### Date text

- **The text form** is ISO 8601 ([ADR 0023](../docs/adr/0023-named-time-zones-come-from-a-standard-capability.md)):
  - `2026-09-27` for a date-only value
  - `2026-09-27T14:30:00` for a date-time
  - `2026-09-27T13:30:00Z` for an Instant, always in UTC
- **A fraction of a second** appears only when it isn't zero, with up to nine digits and no trailing zeros: `2026-09-27T14:30:00.5`.
- **`as civil date`** reads exactly that form, after White_Space is trimmed from either end: four digits of year, then `-`, two of month, `-` and two of day, and optionally `T`, two digits each of hour, minute and second, separated by `:`, and an optional fraction of one to nine digits. Text with a `Z` or an offset raises `can't convert`, and so does a date or time that doesn't exist, such as `2026-02-30` or a 60th second. The year `0000`, which the form can write but the range leaves out, raises `out of range`.
- **`as instant`** reads a date-time in the same form, followed by `Z` or a numeric offset (`+01:00`, `-05:30`) of less than 24 hours, and converts it to UTC. One that lands outside the range in UTC raises `out of range`.

> **Example.**
>
> ```talk
> put "2026-09-27T14:30:00" as civil date into meeting
> put "2026-09-28T10:00:00+01:00" as instant into stamp   -- 2026-09-28T09:00:00Z
> put stamp + 90 min into later
> put "2026-01-31" as civil date + 1 month into renewal    -- 2026-02-28
> ```

## Text Patterns

- **A Text Pattern is a value** of kind `pattern`: a compiled matcher and its canonical source. A `<…>` literal makes one when it is evaluated, and a pattern spliced into it is copied in then ([chapter 4](04-expressions-and-statements.md#text-patterns)).
- **Comparison:** two Text Patterns are equal when their canonical sources are, and they aren't ordered.
- **At the Host,** a Text Pattern can be passed back unchanged, but a Host can't build one.

## Function Values

- **A Function Value** is plain data: its Home Script, the Lambda or named function it came from, and the values it captured ([ADR 0025](../docs/adr/0025-lambdas-are-first-class-function-values-that-run-in-their-home-script.md)). Calling one is in [chapter 4](04-expressions-and-statements.md#calls).
- **Its display form** names the Home Script, the Lambda's position and the captures, as in `<function weather:12:3 {n: 3}>`.
- **Stale:** once its Home Script stops or reloads, or its code is replaced, it is stale, and calling it raises `function gone`. It stays an ordinary value, and still compares by the rule above.
- **Its arity and name:** the Built-ins `functionArity(f)` and `functionName(f)` read the argument counts it accepts and the name of the function it came from, so Scripts never need to read its display form ([chapter 7](07-libraries-and-the-standard-library.md#values), [ADR 0043](../docs/adr/0043-values-are-introspected-through-built-in-functions.md)).

## Host Objects

- **A Host Object** is a handle to something the Host owns. Two are equal only when they are the same object ([ADR 0016](../docs/adr/0016-messages-reach-scripts-through-core-owned-object-parents.md)).
- **Its id** is held by the Core, so `the id of o` reads it without calling the Host.
- **Disposed:** a disposed object stays an ordinary value, with its id and its equality. The Built-in `isDisposed(o)` tests it.
- **Properties** are read with `the p of o` and written with `set`. Each is a call into the Host ([chapter 9](09-embedding.md)).

## Outside parity

- **Representation:** how a Core stores values, such as sharing, copy on write, ropes or its decimal internals, as long as no Script and no Trace can tell ([ADR 0001](../docs/adr/0001-value-semantics.md)).
