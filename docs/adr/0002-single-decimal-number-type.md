# One decimal number type, defined by the spec

The language has a single number type: a decimal with 34 significant digits and round-half-even rounding, following the General Decimal Arithmetic model (decimal128-style). Arithmetic keeps trailing zeros (`2.50 * 3` gives `7.50`), but equality compares by value (`1.0 = 1`). There is no NaN and no Infinity. Division by zero and exponent overflow are errors. There is no separate integer kind: `is an integer` is a test on the value. We chose this because results have to be bit-for-bit identical in Go and JS, and we implement the arithmetic ourselves in each core, so determinism comes from the spec rather than from the host. It also gives beginners `0.1 + 0.2 = 0.3`, makes money work without surprises, and makes Unit conversion exact, since imperial/metric factors such as 0.3048 and 0.45359237 are exact decimals.

## Considered Options

- **float64 only** (the JS model). Native and fast in both hosts. But `sin`, `exp` and `pow` differ between Go's `math` and V8, so we would need our own maths library anyway, and binary rounding breaks both beginner arithmetic and Unit conversion.
- **Integer plus float split** (Python/Elixir). Two numeric kinds make `1 = 1.0` a real question, and `0.1 + 0.2` is still wrong.
- **Arbitrary-precision rationals.** Exact, but memory grows without bound (a problem under a hard memory cap) and results print badly.

## Consequences

- Arithmetic is slower than native floats. That's acceptable, because fuel-metered interpretation already dominates the cost.
- Both cores need their own decimal implementation, including transcendental functions whose rounding the spec must define (left to the stdlib outline).
- Numbers crossing the Host boundary have to be converted between host floats and decimals, following a rule the spec defines.
- The canonical text form is locale-free, with no global `numberFormat`. Formatting is always an explicit call.
- Narrowed by ADR 0021: transcendental functions are Built-ins, correctly rounded (the exact value rounded half-even to 34 digits), and an argument outside the domain raises `out of domain`. `round(x, places, mode)` rounds half away from zero by default, with the mode named as text. Floats come in and go out only through `fromFloat64`/`toFloat64` and the 32-bit pair.
- Narrowed by ADR 0030: the value model has no negative zero. Every zero result, and every `-0.0` a Host passes in, is `0`, and the exponent is kept (`-0.00` becomes `0.00`). A Host float becomes a decimal through its shortest round-trip text, so `0.1` stays `0.1`. NaN, ±Infinity and more than 34 significant digits are refused at the Host API. A Host reads a number as an opaque `Decimal`: its canonical `String()`, exact integer reads that fail unless the value fits, and a visibly lossy float read.
