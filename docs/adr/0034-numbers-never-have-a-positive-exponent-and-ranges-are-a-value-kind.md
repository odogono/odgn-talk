# Numbers never have a positive exponent, and ranges are a value kind

A number's exponent is never positive. An arithmetic result with a positive exponent is rescaled to exponent 0, and a result of 10^34 or more in magnitude raises `overflow`. The smallest exponent is decimal128's, −6176, and a result that needs a smaller one is rounded half-even at −6176. So every number prints in plain notation, which is the literal syntax, and `as number` reads every number back. A range (`3..7`, `3 m/s..7 m/s`) is a value kind of its own, `range`, with two ends that are both numbers or both Quantities of one dimension. The Host API gains a `range` Kind, and the Value Encoding a `$range` tag. Unit conversion is plain decimal arithmetic with no extra rule, so `5 kg + 250 g` gives `5.250 kg`. The only Typed Element is `a number`. A Script's own names may shadow Built-in functions, as they already may Built-in Constants. We chose this because the lexer, `as number` and a Host's `Dec` share one number syntax with no exponent (ADR 0030), and the display form has to read back in a Trace (ADR 0018). Under General Decimal Arithmetic, `1 / 0.01` has exponent 2, and a plain `100` would read back as a different representation of the same value, which prints differently after the next multiplication. Ranges were made first-class values in #8, and a Match's `range` field is one (#69). A kind the Host can't read would stop a Match from reaching a Capability. Dropping the zeros that a factor adds would be a hidden rounding rule on Quantities only, which ADR 0002 rules out, since rounding is always an explicit `round`. A Typed Element converts after the match and the matcher never goes back (ADR 0007), so a Typed Element has to be one whose matched text always has the right syntax, and a date such as `2026-02-30` has the syntax of a date without being one. Built-ins are always in scope, so if they couldn't be shadowed, each new one would break the Scripts that already use its name. Settled in #89.

## Considered Options

- **Full decimal128, with `E` exponents in the text form** (`1E+40`): it gives a range up to 10^6145, but `as number` and the display form would need a second number syntax that source literals don't have, and a Script of this kind never needs numbers that large.
- **Keeping positive exponents but printing plain notation:** `1E+2` would print as `100` and read back with exponent 0, so the Trace wouldn't round-trip.
- **A smaller smallest exponent, such as −68:** it bounds the text form of tiny numbers, but a few divisions would round a small value to zero where decimal128 keeps it.
- **Ranges as a Script-only kind, refused at the Host with `not encodable`:** no change to the Host API, but a Match couldn't be passed to a Capability until its range was taken apart.
- **Ranges as lists of their integers:** `1..1000000` would be a million values, and a Quantity range such as `3 m/s..7 m/s` can't be a list at all.
- **Ranges over Civil Dates, Instants or text:** useful for `d is in start..finish`, but nothing asked for it yet, and it can be added later without breaking a Script.
- **Dropping the trailing zeros a factor adds** (`5 kg + 250 g` giving `5.25 kg`, as the syntax sketch expected): it reads better, but it is a special rounding rule for Quantities, and deciding which zeros "the factor added" needs a rule of its own.
- **A load error for a variable named like a Built-in function**, the strict reading of ADR 0025: adding a Built-in would then be a breaking change.
- **A Typed Element for Civil Dates** (`a civil date`), where a date that doesn't exist makes the match fail: a search would have to go back and try the next position, which is backtracking outside the matcher.

## Consequences

- **Numbers:** narrows ADRs 0002 and 0030.
  - A number is a sign, a coefficient of at most 34 digits and an exponent from −6176 to 0. There is no negative zero, and a zero keeps its exponent.
  - Every operation's result is the exact result, rounded half-even once, to 34 significant digits or at exponent −6176 if that keeps fewer. A magnitude of 10^34 or more raises `overflow`. Otherwise the result takes the exponent nearest the operation's ideal exponent, among those from −6176 to 0, so an ideal exponent above 0 gives 0.
  - The text form is always plain: an optional `-`, the integer digits, and when the exponent is negative, `.` and exactly that many fraction digits.
  - A source literal or `as number` text with more than 34 significant digits, a magnitude of 10^34 or more, or more than 6176 fraction digits doesn't convert. In source it is a load error, and `as number` raises `can't convert`.
  - A Host float or decimal of 10^34 or more in magnitude is refused as `invalid value`, as NaN and more than 34 significant digits already are. `fromFloat64` and `fromFloat32` raise `can't convert` for the same values. Every number is then below the largest float32, so `toFloat64`, `toFloat32` and the Host's lossy float reads never overflow, and `Float64Lossy()` returns no error.
  - `as number` reads a plain number only, so `"5 kg" as number` raises `can't convert`, and text with a Unit converts with `as` and a Unit (`"5 kg" as g`). This reverses #8, where `"5 kg" as number` gave a Quantity, since `Dec` and the JSON codecs share the number syntax and never produce a Quantity (ADR 0021).
- **Ranges:** narrows ADRs 0001 and 0030.
  - `a..b` makes a range from two numbers, or from two Quantities of one dimension. Other ends raise `wrong kind`, and Quantities of two dimensions raise `incompatible units`. Each end is kept as written, and a reversed range is a value like any other.
  - Two ranges are equal when their ends are equal by `=`. Ranges aren't ordered.
  - `x is in a..b` is `a <= x and x <= b`. `repeat for each` walks a range whose ends are integers, one at a time, and chunk indexes take integer ranges.
  - A range whose ends are integers also reads like the list of its integers: `the length of`, `item n of` and `the items of`.
  - The display form is `3..7` or `3 m/s..7 m/s`, and its text form is the same.
  - The Host reads a range with `AsRange()` / `asRange()`, which give the two ends as Values, and builds one with `Range(from, to)` / `range(from, to)`, which checks the ends as `..` does. The Kind is `range` (`KindRange` in Go).
  - The Value Encoding writes a range as `{"$range": [from, to]}`, with each end in the Value Encoding.
  - A range is data, so it passes a data Shape and plain JSON refuses it with `not encodable`.
- **Unit conversion:** settles ADR 0022's open question.
  - Converting a Quantity into Base Units multiplies it by the Unit's numerator factors and then divides by its denominator factors, each step rounded as any operation is. Converting out of Base Units does the reverse.
  - No rule removes trailing zeros afterwards, so `5 kg + 250 g` gives `5.250 kg`. A Script rounds with `round`.
- **Typed Elements:** narrows ADR 0007 and the glossary's example.
  - `a number` is the only Typed Element. It matches an optional `-`, one or more ASCII digits, and optionally `.` and one or more digits, and it binds a number.
  - A date in text is captured as text and converted with `as civil date` after the match.
- **Built-in function names:** narrows ADRs 0025 and 0029.
  - A Script's variable, parameter, Capture or Constant may shadow a Built-in function, as it may a Built-in Constant, and the Script's name wins inside that Script. A variable named like one of the Script's own or imported functions stays a load error.
  - Built-ins are ambient, so under a load error every new Built-in in a later language version would break the Scripts that already use its name, and `day`, `second`, `min` and `max` are common variable names. Imports name what they bring in (ADR 0020), so a Library's new functions can't break a Script either way.
  - Narrows ADR 0020, settled in #91: an Import, and a Script's or Library's own Handler, function or Constant, may also shadow a Built-in. Otherwise a new Built-in would break every Script that defines or imports a function of that name, such as a user Library's `clamp`. An Import that clashes with the Script's own definitions stays a load error.
  - The `shadows-builtin` Lint (ADR 0027) also flags a shadowed Built-in function, as a warning in both Lint Profiles, since calling the shadowed function is a likely bug.
- **Spec:** chapter 3 states the number, range and conversion rules, chapter 4 the Typed Element, and `talk.go` and `talk.ts` gain the `range` Kind. Chapter 9 writes the `$range` tag into the Value Encoding.
