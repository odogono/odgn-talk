# Compound Units convert into the left operand's Units, over base dimensions

Every Unit in the Unit Catalogue is an exact factor times a product of base dimensions: length, mass, exact time, temperature difference, and one dimension per currency. Two Quantities are comparable and convertible when their dimensions match, so `L` (0.001 m^3) converts to `m^3`, and `mi/hr` converts to `km/hr`. Calendar Units (`month`, `year`) form a Unit Kind of their own, outside the dimension system, and never appear in a Compound Unit. A Compound Unit is written with no spaces, using `*` for a product, one `/` before the denominator and positive integer exponents after `^` (`kg*m/s^2`, `mi/hr`, `1/s`). In `×` and `÷`, each factor of the right operand converts into the Unit the left operand already uses for that dimension, and exponents merge: `2 m * 3 ft` gives `1.8288 m^2` and `60 mi/hr * 2 hr` gives `120 mi`. A result with no dimension left is a plain number (`4 yd / 2 ft` gives `6`). A named Unit that isn't a single base dimension (`L`, `mL`) is an atomic factor. It merges only with the same kind of named Unit, so `4 L / 2 m` gives `2 L/m` and `2 L * 2 L` gives `4 L^2`. Nothing collapses into a named Unit by itself; `as` is the only way. Factors print in the catalogue's Kind order, so `3 kg * 2 m` and `2 m * 3 kg` both give `6 kg*m`. We chose this because it extends #8's rule for `+` and `-` (the result takes the left operand's Unit) to `×` and `÷`, so one rule covers all four operators, and the Units a Script's author chose survive the arithmetic. Every Quantity has to print in a form that reads back (ADR 0018), so every Unit that arithmetic can produce must be writable. That rules out a notation without products. Positive exponents with one `/` keep `mi/hr` reading the way people write it.

## Considered Options

- **Reduce to Base Units:** uniform, but `60 mi/hr * 2 hr` would give `193121.28 m`, which discards the Units the author wrote.
- **Keep mixed factors until an explicit `as`:** `2 m * 3 ft` would give `6 m*ft` and `4 yd / 2 ft` would give `2 yd/ft`. That contradicts #8's `4 yd / 2 ft` → `6`, and needs a separate cancellation rule.
- **Flat named Kinds** (volume its own Kind, with no link to length): simpler, but `2 m * 3 m * 4 m as L` would fail.
- **Negative exponents as the canonical form** (`kg*m*s^-2`): regular, but `mi/hr` would print as `mi*hr^-1`.
- **`.` or `·` for products** (UCUM's `kg.m`): `.` collides with decimals and with `..` ranges, and `·` can't be typed on most keyboards.
- **Automatic collapse into named Units** (`km/hr` → `kph`, `m^3` → `L`): it needs a preference order between equal Units, and the catalogue has no named speed or area Units to collapse into.
- **Calendar Units inside compounds** (`12 USD/month`): a month is not a fixed number of seconds, so the Quantity couldn't convert or compare against `USD/day`.
- **Every ISO 4217 code as a Unit:** about 180 uppercase suffixes, and a language version for each change to the list. Ten codes cover almost all real use, and other currencies stay plain numbers or map fields.
- **Minor-unit rounding for currencies** (JPY 0 places, USD 2): it would be a hidden rounding rule on arithmetic, which ADR 0002 rules out. Rounding stays an explicit `round`.
- **Synonyms** (`h` for `hr`, `sec` for `s`): a value would print differently from how it was written.
- **`day` and `week` as Calendar Units, as in Temporal:** Instants and Civil Dates carry no zone in the core, so a day is always 86400 s there. `stamp + 1 day` should work.
- **A prefix system** (`k`, `m`, `µ` on any Unit): it would produce `mmin` and `kmi`, and `µ` isn't ASCII. Prefixed Units are listed one by one.
- **Absolute temperatures pivoting through kelvin** (`toFahrenheit(fromCelsius(20))`): fewer names, but the kelvin in the middle is hidden.

## Consequences

- **Unit Kinds in v1:** length, mass, exact duration, calendar duration, volume, temperature difference, and currencies.
  - There are no named area or speed Units: write `m^2` and `mi/hr`.
  - There are no angle, force, energy, pressure or data-size Units (ADR 0013).
- **Contents:** every Unit that isn't `degF` has an exact decimal factor to its Base Unit.
  - Length (Base Unit `m`): `mm`, `cm`, `m`, `km`, `inch` (0.0254 m), `ft` (0.3048), `yd` (0.9144), `mi` (1609.344).
  - Mass (`kg`): `mg`, `g`, `kg`, `lb` (0.45359237 kg), `oz` (0.028349523125 kg).
  - Exact duration (`s`): `ms`, `s`, `min`, `hr`, `day` (86400 s), `week` (604800 s).
  - Calendar duration (`month`): `month`, `year` (12 months).
  - Volume (`L`, dimension length^3): `mL`, `L` (0.001 m^3).
  - Temperature difference (`degC`): `degC`, `degF`. The `degF` factor is the ratio 5/9, and conversion multiplies by the numerator and then divides by the denominator, so `9 degF as degC` gives `5`. It is the only factor written as a ratio.
  - There are no gallons, pints or cups, because the US and imperial measures clash, and no `K` Unit.
- **Currencies:** narrows ADR 0021.
  - The Units are `USD`, `EUR`, `GBP`, `JPY`, `CHF`, `CNY`, `CAD`, `AUD`, `INR` and `SEK`. Each is its own Unit Kind and its own base dimension, and nothing converts between them.
  - They take part in compounds, so an exchange rate is a value: `10 USD / 2 EUR` gives `5 USD/EUR`, and `100 EUR * 1.1 USD/EUR` gives `110 USD`.
  - There is no minor-unit rounding. `1.005 USD` stays exact.
- **Durations:** narrows #8.
  - `1 month + 1 day` is an error, because the two are different Kinds.
  - A Civil Date with no time of day, plus an exact duration that isn't a whole number of days, is an error.
  - Civil − Civil gives `days`, which converts to `hr` like any exact duration.
- **Spellings:** each Unit has one canonical spelling. Word Units (`inch`, `day`, `week`, `month`, `year`) also have a plural, and both forms are accepted anywhere. There are no synonyms, so the draft's `h` is dropped.
- **Notation:** narrows ADR 0019.
  - A Compound Unit is written with no spaces: factors joined by `*`, at most one `/` before the denominator, and `^n` with n a positive integer.
  - A Unit with only a denominator is written `1/s` (`5 1/s`).
  - A spaced `*` or `/` is arithmetic. `s^-1` is a syntax error.
- **Arithmetic:**
  - Each factor slot is a base dimension, or a named Unit such as `L` that isn't a single base dimension. A Quantity uses one Unit per slot.
  - When the left operand has no Unit in a slot, the right operand's Unit is kept: `2 m * 3 s` gives `6 m*s`.
  - A plain number takes part as a Quantity with no Units: `2 * 3 kg` gives `6 kg`, and `1 / 2 s` gives `0.5 1/s`.
  - `as` converts only between equal dimensions (`60 mi/hr as km/hr`, `24 m^3 as L`). Given a plain number, `as` attaches the Unit (#8).
  - Arithmetic and `as` go through Base Units. Each operand converts to Base Units, the operation happens there, and the result converts into the result's Units, with ADR 0002's rounding at each step. So `4 yd / 2 ft` is `3.6576 / 0.6096`, which is exactly `6`. Converting `ft` straight into `yd` would multiply by 1/3 and give 5.999….
- **Printed form:** in the display form (ADR 0018), a Quantity is its canonical number, one space, then its Unit.
  - A standalone word Unit is singular when the value's magnitude is exactly 1 (`1 day`, `1.0 day`, `-1 day`), and plural otherwise (`3 days`).
  - Units inside a Compound Unit are always singular (`5 inch/s`).
  - Numerator and denominator factors each print in Kind order: mass, length, volume, exact time, temperature difference, then currencies in catalogue order.
  - A Quantity range prints as `3 m/s..7 m/s`.
- **Absolute temperature:** the `units` Library has `celsiusToFahrenheit`, `fahrenheitToCelsius`, `celsiusToKelvin`, `kelvinToCelsius`, `fahrenheitToKelvin` and `kelvinToFahrenheit`. Each takes and returns a plain number.
- **Spec file:** `units.toml` holds the Unit Catalogue. The language version pins it, and the generator emits it into both Cores (ADR 0009).
  - `[[kind]]` entries hold a name, a Base Unit and a dimension.
  - `[[unit]]` entries hold a name, an optional plural, a dimension, the factor to the Base Unit as a decimal string (or a ratio of two), and whether it is a Calendar Unit.
  - `grammar.toml`'s `[units]` table points to it.
  - The generator rejects any name or plural that is a Reserved Word, a FOLLOW-set word or a duplicate.
- **Left for later:**
  - The Error Codes for a dimension mismatch and a bad `as` target.
  - The Cost Model rates for conversion.
  - Whether conversion drops the trailing zeros a factor introduces. Under ADR 0002 alone, `5 kg + 250 g` gives `5.250 kg`, where the syntax sketch expected `5.25 kg`.
  - Lexer changes in the parser prototype: accept `*` and a leading `1/`, and reject `^-n`.
