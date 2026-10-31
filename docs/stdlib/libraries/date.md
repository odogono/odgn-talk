# date

<!-- Generated from spec/data/stdlib.toml by tools/spec/generate.ts. Edit those, then run `bun run spec:gen`. -->

The `date` Library is part of the Standard Library, so every Group holds it. A Script imports the names it uses, as in `use makeDate from date`. Its normative source is [`spec/stdlib/date.talk`](../../../spec/stdlib/date.talk), and the full rules are in [chapter 7](../../../spec/07-libraries-and-the-standard-library.md#date).

An argument of the wrong kind raises `wrong kind` before any work is done, so the entries below list only the other errors each raises ([every stdlib function](../../../spec/07-libraries-and-the-standard-library.md#rules-for-every-stdlib-function)).

### makeDate

`makeDate(y, m, d)`

The date-only Civil Date `y`-`m`-`d`.

Also raises: [`out of range`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### makeDateTime

`makeDateTime(y, m, d, h, mi, s = 0, us = 0)`

The date-time `y`-`m`-`d` at `h`:`mi`:`s` and `us` microseconds.

Also raises: [`out of range`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### atTime

`atTime(d, h, mi, s = 0, us = 0)`

The date-time on the date of `d` at `h`:`mi`:`s` and `us` microseconds.

Also raises: [`out of range`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### dateOnly

`dateOnly(d)`

The date of the Civil Date `d`, without its time of day.

### daysInMonth

`daysInMonth(d)`

The number of days in the month of the Civil Date `d`.

### isLeapYear

`isLeapYear(y)`

Whether the integer `y` is a leap year in the proleptic Gregorian calendar.

### formatDate

`formatDate(d, template)`

The Civil Date `d` written by `template`.

Also raises: [`out of domain`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### parseDate

`parseDate(t, template)`

The Civil Date the text `t` writes by `template`.

Also raises: [`can't convert`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`out of domain`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`out of range`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### splitDuration

`splitDuration(d)`

The exact duration `d` as the map `{days, hours, minutes, seconds}`.

Also raises: [`incompatible units`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### monthsBetween

`monthsBetween(a, b)`

The number of whole calendar months from the Civil Date `a` to `b`, negative if `b` is earlier.

Also raises: [`can't compare`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### epoch

`epoch` = `1970-01-01T00:00:00Z`

The Unix epoch, as an Instant.
