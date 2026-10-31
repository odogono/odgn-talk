# Built-ins

<!-- Generated from spec/data/stdlib.toml by tools/spec/generate.ts. Edit those, then run `bun run spec:gen`. -->

A Built-in is always available, with no `use`, and is the only kind of function a Guard may call. A Script's own name may shadow one. The rules are in [chapter 7](../../spec/07-libraries-and-the-standard-library.md#built-ins).

An argument of the wrong kind raises `wrong kind` before any work is done, so the entries below list only the other errors each raises ([every stdlib function](../../spec/07-libraries-and-the-standard-library.md#rules-for-every-stdlib-function)).

## Values

The full rules: [chapter 7](../../spec/07-libraries-and-the-standard-library.md#values).

### min

`min(x, …)`

The least of its arguments under `<`, the first of equal ones; a lone list argument gives the least of its items.

Also raises: [`out of domain`](../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`can't compare`](../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### max

`max(x, …)`

The greatest of its arguments under `<`, the first of equal ones; a lone list argument gives the greatest of its items.

Also raises: [`out of domain`](../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`can't compare`](../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### codePoint

`codePoint(c)`

The code point of `c`, a text of exactly one code point, as a number.

Also raises: [`out of domain`](../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### fromCodePoint

`fromCodePoint(n)`

The text of the code point `n`, normalised to NFC.

Also raises: [`out of domain`](../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### upper

`upper(s)`

`s` under Unicode full default uppercase mapping, then NFC.

### lower

`lower(s)`

`s` under Unicode full default lowercase mapping, then NFC.

### offset

`offset(needle, s)`

The Character position where the leftmost match of `needle`, a text or a Text Pattern, starts in `s`, or 0 if there is none.

### isDisposed

`isDisposed(o)`

Whether the Host Object `o` has been disposed.

### objectKind

`objectKind(o)`

The name of the Object Kind of the Host Object `o`, as text.

### rangeStart

`rangeStart(r)`

The first end of the range `r`, as written.

### rangeEnd

`rangeEnd(r)`

The second end of the range `r`, as written.

### kindOf

`kindOf(x)`

The name of the kind of `x`, as text, such as `"number"` or `"civil date"`.

### conforms

`conforms(value, shape)`

Whether `value` fits the Shape `shape`.

Also raises: [`invalid shape`](../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### check

`check(value, shape)`

`value` unchanged, if it fits the Shape `shape`; raises the first mismatch otherwise.

Also raises: [`invalid shape`](../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`not encodable`](../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### explain

`explain(value, shape)`

The list of every mismatch of `value` against the Shape `shape`, empty if it fits.

Also raises: [`invalid shape`](../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### functionArity

`functionArity(f)`

The range of argument counts the Function Value `f` accepts, from its required parameters to all of them.

### functionName

`functionName(f)`

The name of the function the Function Value `f` was made from, as defined, or Nothing for a Lambda.

### offerAvailable

`offerAvailable(textName)`

Whether the current recovery's retained failure chain has an eligible offer with this Name; false outside recovery or for a malformed or unknown Name.

## Numbers

The full rules: [chapter 7](../../spec/07-libraries-and-the-standard-library.md#numbers).

### abs

`abs(x)`

`x` without its sign.

### floor

`floor(x)`

The greatest integer at or below `x`.

### ceiling

`ceiling(x)`

The least integer at or above `x`.

### truncate

`truncate(x)`

`x` with its fraction dropped, toward zero.

### round

`round(x, places = 0, mode = "half up")`

`x` rounded to `places` digits after the point, by `mode`.

Also raises: [`out of domain`](../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### sqrt

`sqrt(x)`

The square root of `x`.

Also raises: [`out of domain`](../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### exp

`exp(x)`

e to the power `x`.

Also raises: [`overflow`](../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### ln

`ln(x)`

The natural logarithm of `x`.

Also raises: [`out of domain`](../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### log10

`log10(x)`

The base-10 logarithm of `x`.

Also raises: [`out of domain`](../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### power

`power(x, y)`

`x` to the power `y`.

Also raises: [`out of domain`](../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`overflow`](../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### sin

`sin(x)`

The sine of `x` radians.

### cos

`cos(x)`

The cosine of `x` radians.

### tan

`tan(x)`

The tangent of `x` radians.

### asin

`asin(x)`

The arcsine of `x`, in radians from -pi/2 to pi/2.

Also raises: [`out of domain`](../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### acos

`acos(x)`

The arccosine of `x`, in radians from 0 to pi.

Also raises: [`out of domain`](../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### atan

`atan(x)`

The arctangent of `x`, in radians between -pi/2 and pi/2.

### atan2

`atan2(y, x)`

The angle of the point (`x`, `y`) from the positive x-axis, in radians above -pi and at most pi.

Also raises: [`out of domain`](../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### degrees

`degrees(x)`

`x` radians in degrees.

Also raises: [`overflow`](../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### radians

`radians(x)`

`x` degrees in radians.

### random

`random(n)`

A whole number from 1 to `n`, the next from the Script Group's generator.

Also raises: [`out of domain`](../../spec/06-errors-and-limits.md#the-error-code-catalogue).

## Bits

The full rules: [chapter 7](../../spec/07-libraries-and-the-standard-library.md#bits).

### bitAnd

`bitAnd(a, b)`

The bits set in both `a` and `b`.

Also raises: [`out of domain`](../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### bitOr

`bitOr(a, b)`

The bits set in `a`, `b` or both.

Also raises: [`out of domain`](../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### bitXor

`bitXor(a, b)`

The bits set in exactly one of `a` and `b`.

Also raises: [`out of domain`](../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### bitNot

`bitNot(x, width)`

`x` with its low `width` bits inverted.

Also raises: [`out of domain`](../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### bitShiftLeft

`bitShiftLeft(x, n, width = nothing)`

`x` shifted left `n` bits, kept to its low `width` bits when `width` is given.

Also raises: [`out of domain`](../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`overflow`](../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### bitShiftRight

`bitShiftRight(x, n)`

`x` shifted right `n` bits, filling with zeros.

Also raises: [`out of domain`](../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### bitRotateLeft

`bitRotateLeft(x, n, width)`

The low `width` bits of `x` rotated left `n` places.

Also raises: [`out of domain`](../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### bitRotateRight

`bitRotateRight(x, n, width)`

The low `width` bits of `x` rotated right `n` places.

Also raises: [`out of domain`](../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### bitCount

`bitCount(x)`

How many bits of `x` are set.

Also raises: [`out of domain`](../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### bitTest

`bitTest(x, i)`

Whether bit `i` of `x` is set, bit 0 being the lowest.

Also raises: [`out of domain`](../../spec/06-errors-and-limits.md#the-error-code-catalogue).

## Floats

The full rules: [chapter 7](../../spec/07-libraries-and-the-standard-library.md#floats).

### fromFloat64

`fromFloat64(b, order = "big")`

The number an IEEE 754 binary64 float in the 8 Bytes `b` holds, as its shortest round-trip decimal.

Also raises: [`out of domain`](../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`can't convert`](../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### fromFloat32

`fromFloat32(b, order = "big")`

The number an IEEE 754 binary32 float in the 4 Bytes `b` holds, as its shortest round-trip decimal.

Also raises: [`out of domain`](../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`can't convert`](../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### toFloat64

`toFloat64(n, order = "big")`

The 8 Bytes of the binary64 float nearest `n`, ties to even.

Also raises: [`out of domain`](../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### toFloat32

`toFloat32(n, order = "big")`

The 4 Bytes of the binary32 float nearest `n`, ties to even.

Also raises: [`out of domain`](../../spec/06-errors-and-limits.md#the-error-code-catalogue).

## Dates

The full rules: [chapter 7](../../spec/07-libraries-and-the-standard-library.md#dates).

### year

`year(d)`

The year of the Civil Date `d`, from 1 to 9999.

### month

`month(d)`

The month of `d`, from 1 to 12.

### day

`day(d)`

The day of the month of `d`, from 1 to 31.

### hour

`hour(d)`

The hour of the date-time `d`, from 0 to 23.

Also raises: [`out of domain`](../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### minute

`minute(d)`

The minute of the date-time `d`, from 0 to 59.

Also raises: [`out of domain`](../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### second

`second(d)`

The whole seconds of the date-time `d`, from 0 to 59.

Also raises: [`out of domain`](../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### microsecond

`microsecond(d)`

The fraction of a second of the date-time `d`, in whole microseconds from 0 to 999999.

Also raises: [`out of domain`](../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### weekday

`weekday(d)`

The ISO 8601 day of the week of `d`, 1 for Monday to 7 for Sunday.

### dayOfYear

`dayOfYear(d)`

The day of the year of `d`, from 1 to 366.

### isoWeek

`isoWeek(d)`

The ISO 8601 week number of `d`, from 1 to 53.

### isoWeekYear

`isoWeekYear(d)`

The ISO 8601 week-numbering year of `d`.

### hasTime

`hasTime(d)`

Whether the Civil Date `d` has a time of day.

### toCivil

`toCivil(i, offset)`

The date-time on the wall clock at `offset` from UTC at the Instant `i`.

Also raises: [`out of domain`](../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`out of range`](../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### toInstant

`toInstant(c, offset)`

The Instant at which the wall clock at `offset` from UTC reads the date-time `c`.

Also raises: [`out of domain`](../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`out of range`](../../spec/06-errors-and-limits.md#the-error-code-catalogue).

## Constants

The full rules: [chapter 7](../../spec/07-libraries-and-the-standard-library.md#constants).

### pi

`pi` = `3.141592653589793238462643383279503`

pi, rounded half-even to 34 digits.

### newline

`newline` = `U+000A`

A line feed, as text.

### tab

`tab` = `U+0009`

A tab, as text.

### quote

`quote` = `U+0022`

A double quote, as text.

## Properties

A Built-in property is read with `the <name> of x`, or `x's <name>`. What each gives, and of which kinds, is in [chapter 4](../../spec/04-expressions-and-statements.md#keys-and-properties).

- `the length of x`
- `the keys of x`
- `the values of x`
- `the items of x`
- `the lines of x`
- `the words of x`
- `the characters of x`
- `the bytes of x`
- `the code points of x`
- `the elements of x`
